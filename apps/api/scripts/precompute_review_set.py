"""Precompute stored judgments for the Gate 1 review set.

Run from apps/api with TYPESAFE_API_KEY (and ideally OPENFDA_API_KEY) set in .env:

    uv run python scripts/precompute_review_set.py [names.txt] [report.json]

Judgments go to DATABASE_URL. Re-running only calls Jev for labels the store lacks. The
report lists every drug's status, labels, tokens, latency and skipped questions.
"""

import json
import sys
from pathlib import Path

import httpx
from sqlmodel import Session
from typesafe_sdk import TypeSafeClient

from rx_jev_api.batch import precompute, read_names
from rx_jev_api.clients.openfda import OpenFdaClient
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.config import get_settings
from rx_jev_api.db import make_engine
from rx_jev_api.deps import JEV_RETRY, JEV_TIMEOUT, UPSTREAM_TIMEOUT
from rx_jev_api.judge import Judge
from rx_jev_api.store import Store

NAMES = Path(__file__).parent / "review_set.txt"
REPORT = Path("review_set_report.json")


def main() -> None:
    names_path = Path(sys.argv[1]) if len(sys.argv) > 1 else NAMES
    report_path = Path(sys.argv[2]) if len(sys.argv) > 2 else REPORT
    settings = get_settings()
    if settings.typesafe_api_key is None:
        sys.exit("TYPESAFE_API_KEY is not set. Add it to apps/api/.env.")
    if settings.openfda_api_key is None:
        print("OPENFDA_API_KEY is not set; anonymous openFDA access may hit its daily limit.")

    names = read_names(names_path.read_text())
    openfda_key = settings.openfda_api_key.get_secret_value() if settings.openfda_api_key else None
    with (
        httpx.Client(base_url=settings.rxnorm_base_url, timeout=UPSTREAM_TIMEOUT) as rx_http,
        httpx.Client(base_url=settings.openfda_base_url, timeout=UPSTREAM_TIMEOUT) as fda_http,
        TypeSafeClient(
            api_key=settings.typesafe_api_key.get_secret_value(),
            timeout=JEV_TIMEOUT,
            retry=JEV_RETRY,
        ) as jev,
        Session(make_engine(settings.database_url)) as session,
    ):
        reports = []
        for name in names:
            [report] = precompute(
                [name],
                RxNormClient(rx_http),
                OpenFdaClient(fda_http, openfda_key),
                Judge(jev, settings.typesafe_model),
                Store(session),
            )
            reports.append(report)
            tokens = sum(label.input_tokens or 0 for label in report.labels if label.fresh)
            print(f"{report.status:16} {name}  labels={len(report.labels)}  new_tokens={tokens}")

    report_path.write_text(json.dumps([r.model_dump() for r in reports], indent=2) + "\n")
    failed = [r.name for r in reports if r.status != "ok"]
    print(f"\n{len(reports) - len(failed)}/{len(reports)} ok. Report: {report_path}")
    if failed:
        print("Not ok: " + ", ".join(failed))


if __name__ == "__main__":
    main()
