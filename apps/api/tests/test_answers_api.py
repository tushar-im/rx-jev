from collections.abc import Iterator
from contextlib import contextmanager
from typing import get_args

import httpx
import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlmodel import Session, select

from rx_jev_api.catalog import CATALOG
from rx_jev_api.clients.openfda import CanonicalLabels, Label, OpenFdaClient
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.config import Settings, get_settings
from rx_jev_api.db import make_engine
from rx_jev_api.deps import get_judge, get_openfda_client, get_rxnorm_client, get_session
from rx_jev_api.judge import MAX_CHOICE_OPTIONS, NONE, STANCES, Judge, SkipReason, build_request
from rx_jev_api.main import app
from rx_jev_api.problems import PROBLEM_JSON
from rx_jev_api.store import JudgeRun
from tests.jev import MODEL_VERSION, FakeJev
from tests.recorded import openfda_http, rxnorm_http

METFORMIN = "6809"
IBUPROFEN = "5640"


@pytest.fixture
def engine() -> Engine:
    return make_engine("sqlite://")


@pytest.fixture
def jev() -> FakeJev:
    return FakeJev()


@contextmanager
def serve(engine: Engine, jev: FakeJev | None) -> Iterator[TestClient]:
    """A TestClient on recorded upstreams whose Jev is `jev`, or unconfigured when None."""

    def session() -> Iterator[Session]:
        with Session(engine) as s:
            yield s

    jev_client = jev.client() if jev else None
    app.dependency_overrides[get_rxnorm_client] = lambda: RxNormClient(rxnorm_http())
    app.dependency_overrides[get_openfda_client] = lambda: OpenFdaClient(openfda_http())
    app.dependency_overrides[get_session] = session
    app.dependency_overrides[get_judge] = lambda: Judge(jev_client, "jev-latest")
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def client(engine: Engine, jev: FakeJev) -> Iterator[TestClient]:
    with serve(engine, jev) as c:
        yield c


def runs(engine: Engine) -> int:
    with Session(engine) as s:
        return len(s.exec(select(JudgeRun)).all())


def test_miss_judges_each_label_once_and_stores_it(
    client: TestClient, jev: FakeJev, engine: Engine
) -> None:
    response = client.get(f"/api/labels/{IBUPROFEN}/answers")
    assert response.status_code == 200
    body = response.json()
    assert [label["product_type"] for label in body["labels"]] == ["otc", "prescription"]
    assert len(jev.requests) == 2
    assert runs(engine) == 2
    assert all(label["model_version"] == MODEL_VERSION for label in body["labels"])


def test_hit_serves_from_the_store_without_calling_jev(client: TestClient, jev: FakeJev) -> None:
    first = client.get(f"/api/labels/{METFORMIN}/answers").json()
    second = client.get(f"/api/labels/{METFORMIN}/answers").json()
    assert len(jev.requests) == 1
    assert second == first


def test_every_catalog_question_is_answered_in_order_and_unreviewed(
    client: TestClient,
) -> None:
    label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    assert [a["question_id"] for a in label["answers"]] == [q.id for q in CATALOG]
    assert all(a["reviewed"] is False for a in label["answers"])


def test_answers_carry_label_provenance(client: TestClient) -> None:
    label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    for field in ("set_id", "version", "effective_time", "dailymed_url"):
        assert label[field]


def test_stance_keeps_all_five_categories_apart(client: TestClient) -> None:
    label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    stance = label["answers"][0]["stance"]
    assert stance["choice"] == "warns_against"
    assert list(stance["probabilities"]) == list(STANCES)


def test_question_without_sections_is_not_judged(client: TestClient) -> None:
    otc = client.get(f"/api/labels/{IBUPROFEN}/answers").json()["labels"][0]
    boxed = next(a for a in otc["answers"] if a["question_id"] == "boxed_warning")
    assert boxed["status"] == "no_sections"
    assert boxed["stance"] is None
    assert boxed["evidence"] is None


def test_evidence_quotes_the_candidate_verbatim_with_its_lead_in(
    engine: Engine, metformin_rx: Label
) -> None:
    request = build_request(metformin_rx)
    question_id, candidate = next(
        (qid, c) for qid, cands in request.asked.items() for c in cands if c.lead_in
    )
    jev = FakeJev(pick=lambda key, options: candidate.id if candidate.id in options else options[0])
    with serve(engine, jev) as client:
        label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]

    answer = next(a for a in label["answers"] if a["question_id"] == question_id)
    evidence = answer["evidence"]
    assert answer["status"] == "judged"
    assert evidence["choice"] == candidate.id
    assert evidence["probability"] == 0.9
    assert evidence["quote"] == {
        "section": candidate.section,
        "text": candidate.text,
        "lead_in": candidate.lead_in.text if candidate.lead_in else None,
    }
    assert candidate.text in metformin_rx.sections[candidate.section]


def test_evidence_none_has_no_quote(engine: Engine) -> None:
    jev = FakeJev(pick=lambda key, options: NONE if NONE in options else options[0])
    with serve(engine, jev) as client:
        label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    evidence = label["answers"][0]["evidence"]
    assert evidence["choice"] == NONE
    assert evidence["quote"] is None


def test_jev_failure_is_503_and_stores_nothing(engine: Engine) -> None:
    with serve(engine, FakeJev(status=529)) as client:
        response = client.get(f"/api/labels/{IBUPROFEN}/answers")
    assert response.status_code == 503
    assert response.headers["content-type"] == PROBLEM_JSON
    assert response.json()["status"] == 503
    assert "529" not in response.text
    assert runs(engine) == 0


def test_failure_on_a_later_label_stores_no_earlier_label_either(engine: Engine) -> None:
    class FailsSecond(FakeJev):
        def _handle(self, request: httpx2.Request) -> httpx2.Response:
            self.status = 200 if not self.requests else 529
            return super()._handle(request)

    jev = FailsSecond()
    with serve(engine, jev) as client:
        response = client.get(f"/api/labels/{IBUPROFEN}/answers")
    assert len(jev.requests) == 2
    assert response.status_code == 503
    assert runs(engine) == 0


def test_missing_api_key_is_503(engine: Engine) -> None:
    with serve(engine, None) as client:
        response = client.get(f"/api/labels/{METFORMIN}/answers")
    assert response.status_code == 503
    assert response.headers["content-type"] == PROBLEM_JSON


class OneLabel(OpenFdaClient):
    """openFDA returning a fixed canonical prescription label, without any HTTP."""

    def __init__(self, label: Label) -> None:
        def unexpected(request: httpx.Request) -> httpx.Response:
            raise AssertionError(f"Unexpected openFDA request: {request.url}")

        super().__init__(httpx.Client(transport=httpx.MockTransport(unexpected)))
        self._label = label

    def canonical_labels(self, ingredients: list[str]) -> CanonicalLabels:
        return CanonicalLabels(otc=None, prescription=self._label)


def test_label_with_every_question_skipped_is_served_without_jev(
    engine: Engine, jev: FakeJev, metformin_rx: Label
) -> None:
    # A canonical label that has none of the sections any catalog question reads.
    label = metformin_rx.model_copy(
        update={
            "sections": {"indications_and_usage": metformin_rx.sections["indications_and_usage"]}
        }
    )
    with serve(engine, jev) as client:
        app.dependency_overrides[get_openfda_client] = lambda: OneLabel(label)
        response = client.get(f"/api/labels/{METFORMIN}/answers")

    assert response.status_code == 200
    [served] = response.json()["labels"]
    assert served["set_id"] == label.set_id
    assert served["model_version"] is None
    assert served["judged_at"] is None
    assert [a["question_id"] for a in served["answers"]] == [q.id for q in CATALOG]
    for answer in served["answers"]:
        assert answer["status"] in get_args(SkipReason)
        assert answer["stance"] is None
        assert answer["evidence"] is None
        assert answer["reviewed"] is False
    assert jev.requests == []
    assert runs(engine) == 0


def test_question_with_more_sentences_than_one_choice_holds_is_judged(
    engine: Engine, jev: FakeJev, metformin_rx: Label
) -> None:
    long = " ".join(f"Sentence number {n} is here." for n in range(MAX_CHOICE_OPTIONS))
    label = metformin_rx.model_copy(
        update={"sections": metformin_rx.sections | {"contraindications": long}}
    )
    request = build_request(label)
    [question_id, *_] = request.evidence_chunks

    with serve(engine, jev) as client:
        app.dependency_overrides[get_openfda_client] = lambda: OneLabel(label)
        response = client.get(f"/api/labels/{METFORMIN}/answers")

    assert response.status_code == 200
    [served] = response.json()["labels"]
    answer = next(a for a in served["answers"] if a["question_id"] == question_id)
    assert answer["status"] == "judged"
    assert answer["stance"] is not None
    quote = answer["evidence"]["quote"]
    assert quote["text"] in label.sections[quote["section"]]
    assert len(jev.requests) == len(request.parts) + 1


def test_answers_below_the_display_threshold_are_not_confident(client: TestClient) -> None:
    # FakeJev answers with confidence 0.8, under the 0.9 set at Gate 1.
    label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    assert label["answers"]
    assert all(a["confident"] is False for a in label["answers"])


def test_confident_needs_both_confidences_at_the_threshold(engine: Engine, jev: FakeJev) -> None:
    with serve(engine, jev) as client:
        app.dependency_overrides[get_settings] = lambda: Settings(
            _env_file=None, display_min_confidence=0.8
        )
        label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    judged = [a for a in label["answers"] if a["status"] == "judged"]
    skipped = [a for a in label["answers"] if a["status"] != "judged"]
    assert judged and all(a["confident"] is True for a in judged)
    assert all(a["confident"] is False for a in skipped)


@pytest.mark.parametrize(
    ("stance_conf", "evidence_conf", "expected"),
    [(0.95, 0.95, True), (0.95, 0.85, False), (0.85, 0.95, False), (0.9, 0.9, True)],
)
def test_confident_only_when_stance_and_evidence_both_reach_the_threshold(
    engine: Engine, stance_conf: float, evidence_conf: float, expected: bool
) -> None:
    def confidence(key: str) -> float:
        return stance_conf if key.endswith(".stance") else evidence_conf

    with serve(engine, FakeJev(confidence=confidence)) as client:
        label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    judged = [a for a in label["answers"] if a["status"] == "judged"]
    assert judged
    assert all(a["confident"] is expected for a in judged)


def test_evidence_none_is_never_confident(engine: Engine) -> None:
    jev = FakeJev(pick=lambda key, options: NONE if NONE in options else options[0])
    with serve(engine, jev) as client:
        app.dependency_overrides[get_settings] = lambda: Settings(
            _env_file=None, display_min_confidence=0.8
        )
        label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    judged = [a for a in label["answers"] if a["status"] == "judged"]
    assert judged and all(a["evidence"]["choice"] == NONE for a in judged)
    assert all(a["confident"] is False for a in judged)


def test_gate_1_display_threshold_is_the_default() -> None:
    assert Settings(_env_file=None).display_min_confidence == 0.9


def test_unknown_rxcui_is_404_problem(client: TestClient, jev: FakeJev) -> None:
    response = client.get("/api/labels/0/answers")
    assert response.status_code == 404
    assert response.headers["content-type"] == PROBLEM_JSON
    assert jev.requests == []
