"""Precomputes stored judgments for a list of drug names, such as the Gate 1 review set.

Each drug is resolved through RxNorm, its canonical labels fetched from openFDA, and every
label the store lacks is judged. A failing drug is reported and the batch moves on. Re-running
the batch only calls Jev for labels whose version, prompt or model changed.
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from rx_jev_api.answering import judge_labels
from rx_jev_api.catalog import QuestionId
from rx_jev_api.clients.errors import UpstreamError
from rx_jev_api.clients.openfda import OpenFdaClient, ProductType
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.judge import Judge, JudgeError, SkipReason
from rx_jev_api.store import Store

__all__ = [
    "DrugReport",
    "LabelReport",
    "precompute",
    "read_names",
    "unvalidated_labels",
    "write_report",
]

DrugStatus = Literal["ok", "not_found", "no_label", "upstream_failed", "jev_failed"]


class LabelReport(BaseModel):
    set_id: str
    version: str
    product_type: ProductType
    fresh: bool
    # None when no question had candidates, so the label has no stored run.
    model_version: str | None = None
    latency_ms: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    skipped: dict[QuestionId, SkipReason]


class DrugReport(BaseModel):
    name: str
    status: DrugStatus
    rxcui: str | None = None
    labels: list[LabelReport] = []
    error: str | None = None


def write_report(path: Path, reports: list[DrugReport]) -> None:
    """Replace the report atomically, so an interrupted run never leaves partial JSON.

    The JSON goes to a temporary file in the same directory, which is then renamed over the
    report. A rename within one filesystem is atomic, so readers see the old report or the
    new one, never a mix.
    """
    body = json.dumps([r.model_dump() for r in reports], indent=2) + "\n"
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def unvalidated_labels(reports: list[DrugReport], validated_version: str) -> list[str]:
    """Labels whose stored run came from a Jev version other than the one Gate 1 validated.

    Runs are keyed by the requested model name, so a new version behind `jev-latest` only
    reaches labels judged after it ships. Those answers need the thresholds re-checked.
    """
    return [
        f"{report.name} ({label.product_type}, {label.model_version})"
        for report in reports
        for label in report.labels
        if label.model_version is not None and label.model_version != validated_version
    ]


def read_names(text: str) -> list[str]:
    """Drug names, one per line. Blank lines, `#` comments and repeats are dropped."""
    names: dict[str, str] = {}
    for line in text.splitlines():
        name = line.split("#", 1)[0].strip()
        if name:
            names.setdefault(name.lower(), name)
    return list(names.values())


def precompute(
    names: list[str],
    rxnorm: RxNormClient,
    openfda: OpenFdaClient,
    judge: Judge,
    store: Store,
) -> list[DrugReport]:
    return [_one(name, rxnorm, openfda, judge, store) for name in names]


def _one(
    name: str, rxnorm: RxNormClient, openfda: OpenFdaClient, judge: Judge, store: Store
) -> DrugReport:
    try:
        resolution = rxnorm.resolve(name)
        if resolution is None:
            return DrugReport(name=name, status="not_found")
        canonical = openfda.canonical_labels([i.name for i in resolution.ingredients])
    except UpstreamError as exc:
        return DrugReport(name=name, status="upstream_failed", error=str(exc))

    labels = [label for label in (canonical.otc, canonical.prescription) if label is not None]
    if not labels:
        return DrugReport(name=name, status="no_label", rxcui=resolution.rxcui)

    try:
        judged = judge_labels(labels, judge, store)
    except JudgeError as exc:
        cause = f": {exc.__cause__}" if exc.__cause__ else ""
        return DrugReport(
            name=name, status="jev_failed", rxcui=resolution.rxcui, error=f"{exc}{cause}"
        )

    return DrugReport(
        name=name,
        status="ok",
        rxcui=resolution.rxcui,
        labels=[
            LabelReport(
                set_id=j.label.set_id,
                version=j.label.version,
                product_type=j.label.product_type,
                fresh=j.fresh,
                model_version=j.run.model_version if j.run else None,
                latency_ms=j.run.latency_ms if j.run else None,
                input_tokens=j.run.input_tokens if j.run else None,
                output_tokens=j.run.output_tokens if j.run else None,
                skipped=j.request.skipped,
            )
            for j in judged
        ],
    )
