import json
import os
from collections.abc import Iterator
from pathlib import Path

import httpx
import httpx2
import pytest
from sqlalchemy import Engine
from sqlmodel import Session

from rx_jev_api.batch import DrugReport, LabelReport, precompute, read_names, write_report
from rx_jev_api.clients.openfda import OpenFdaClient
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.db import make_engine
from rx_jev_api.judge import Judge
from rx_jev_api.store import Store
from tests.jev import MODEL_VERSION, FakeJev
from tests.recorded import openfda_http, rxnorm_http

MODEL = "jev-latest"


@pytest.fixture
def engine() -> Engine:
    return make_engine("sqlite://")


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    with Session(engine) as s:
        yield s


def run(session: Session, names: list[str], jev: FakeJev) -> list:
    return precompute(
        names,
        RxNormClient(rxnorm_http()),
        OpenFdaClient(openfda_http()),
        Judge(jev.client(), MODEL),
        Store(session),
    )


def test_judges_every_canonical_label_of_every_drug(session: Session) -> None:
    jev = FakeJev()
    reports = run(session, ["Advil", "metformin"], jev)

    assert [(r.name, r.status, r.rxcui) for r in reports] == [
        ("Advil", "ok", "5640"),
        ("metformin", "ok", "6809"),
    ]
    assert [label.product_type for label in reports[0].labels] == ["otc", "prescription"]
    assert len(jev.requests) == 3
    otc = reports[0].labels[0]
    assert otc.fresh is True
    assert otc.model_version == MODEL_VERSION
    assert (otc.input_tokens, otc.output_tokens) == (1234, 56)
    assert otc.skipped == {"boxed_warning": "no_sections"}


def test_rerun_reuses_stored_judgments(session: Session) -> None:
    jev = FakeJev()
    run(session, ["metformin"], jev)
    again = run(session, ["metformin"], jev)
    assert len(jev.requests) == 1
    assert again[0].status == "ok"
    assert again[0].labels[0].fresh is False


def test_a_jev_failure_is_reported_and_the_batch_continues(session: Session) -> None:
    class FailsFirst(FakeJev):
        def _handle(self, request: httpx2.Request) -> httpx2.Response:
            self.status = 529 if not self.requests else 200
            return super()._handle(request)

    reports = run(session, ["metformin", "Tylenol PM"], FailsFirst())
    assert [r.status for r in reports] == ["jev_failed", "ok"]
    assert reports[0].labels == []
    assert reports[0].error


def test_unknown_drug_is_reported_not_raised(session: Session) -> None:
    jev = FakeJev()
    [report] = run(session, ["xyzzynotadrug"], jev)
    assert report.status == "not_found"
    assert jev.requests == []


def test_upstream_failure_is_reported(session: Session) -> None:
    openfda = OpenFdaClient(
        httpx.Client(
            transport=httpx.MockTransport(lambda r: httpx.Response(503)),
            base_url="https://x.test",
        )
    )
    [report] = precompute(
        ["metformin"],
        RxNormClient(rxnorm_http()),
        openfda,
        Judge(FakeJev().client(), MODEL),
        Store(session),
    )
    assert report.status == "upstream_failed"


def test_a_label_report_without_run_metadata_is_valid() -> None:
    report = LabelReport(set_id="s", version="1", product_type="otc", fresh=False, skipped={})
    assert report.model_version is None
    assert (report.latency_ms, report.input_tokens, report.output_tokens) == (None, None, None)


def test_write_report_writes_complete_json_and_leaves_no_temp_files(tmp_path: Path) -> None:
    path = tmp_path / "report.json"
    reports = [DrugReport(name="metformin", status="not_found")]
    write_report(path, reports)
    assert json.loads(path.read_text()) == [r.model_dump() for r in reports]
    assert list(tmp_path.iterdir()) == [path]


def test_an_interrupted_report_write_keeps_the_previous_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "report.json"
    write_report(path, [DrugReport(name="first", status="ok")])
    before = path.read_text()

    def interrupted(src: object, dst: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(os, "replace", interrupted)
    with pytest.raises(KeyboardInterrupt):
        write_report(path, [DrugReport(name="first", status="ok")] * 2)

    assert path.read_text() == before
    assert list(tmp_path.iterdir()) == [path]


def test_read_names_skips_blanks_comments_and_duplicates() -> None:
    text = "# review set\nibuprofen\n\n  metformin  \nIbuprofen\n"
    assert read_names(text) == ["ibuprofen", "metformin"]
