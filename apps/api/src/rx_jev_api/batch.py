"""Precomputes stored judgments for a list of drug names, such as the Gate 1 review set.

Each drug is resolved through RxNorm, its canonical labels fetched from openFDA, and every
label the store lacks is judged. A failing drug is reported and the batch moves on. Re-running
the batch only calls Jev for labels whose version, prompt or model changed.
"""

from typing import Literal

from pydantic import BaseModel

from rx_jev_api.answering import judge_labels
from rx_jev_api.catalog import QuestionId
from rx_jev_api.clients.errors import UpstreamError
from rx_jev_api.clients.openfda import OpenFdaClient, ProductType
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.judge import Judge, JudgeError, SkipReason
from rx_jev_api.store import Store

__all__ = ["DrugReport", "LabelReport", "precompute", "read_names"]

DrugStatus = Literal["ok", "not_found", "no_label", "upstream_failed", "jev_failed"]


class LabelReport(BaseModel):
    set_id: str
    version: str
    product_type: ProductType
    fresh: bool
    model_version: str | None
    latency_ms: int | None
    input_tokens: int | None
    output_tokens: int | None
    skipped: dict[QuestionId, SkipReason]


class DrugReport(BaseModel):
    name: str
    status: DrugStatus
    rxcui: str | None = None
    labels: list[LabelReport] = []
    error: str | None = None


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
