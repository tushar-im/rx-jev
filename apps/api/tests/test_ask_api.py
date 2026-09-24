from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from rx_jev_api.clients.openfda import Label
from rx_jev_api.config import Settings, get_settings
from rx_jev_api.db import make_engine
from rx_jev_api.judge import CUSTOM, NONE, STANCES, build_custom_request
from rx_jev_api.main import app
from rx_jev_api.problems import PROBLEM_JSON
from tests.jev import MODEL_VERSION, FakeJev
from tests.test_answers_api import IBUPROFEN, METFORMIN, runs, serve

GRAPEFRUIT = "Can I drink grapefruit juice while taking this?"


@pytest.fixture
def engine() -> Engine:
    return make_engine("sqlite://")


def ask(client: TestClient, rxcui: str, set_id: str, question: str = GRAPEFRUIT) -> Any:
    return client.post(f"/api/labels/{rxcui}/ask", json={"set_id": set_id, "question": question})


def test_asks_jev_live_about_the_chosen_label_and_stores_nothing(
    engine: Engine, ibuprofen_otc: Label
) -> None:
    jev = FakeJev()
    with serve(engine, jev) as client:
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id)
    assert response.status_code == 200
    body = response.json()
    assert body["rxcui"] == IBUPROFEN
    assert body["label"]["set_id"] == ibuprofen_otc.set_id
    assert body["label"]["version"] == ibuprofen_otc.version
    assert body["label"]["dailymed_url"] == ibuprofen_otc.dailymed_url
    assert body["model_version"] == MODEL_VERSION
    # One label, one request; the other canonical label is not asked.
    assert len(jev.requests) == 1
    assert runs(engine) == 0


def test_the_request_carries_the_reader_question(engine: Engine, ibuprofen_otc: Label) -> None:
    jev = FakeJev()
    with serve(engine, jev) as client:
        ask(client, IBUPROFEN, ibuprofen_otc.set_id)
    expected = build_custom_request(ibuprofen_otc, GRAPEFRUIT).parts[0]
    assert jev.requests[0]["state"] == expected.state
    assert set(jev.requests[0]["questions"]) == set(expected.questions)


def test_the_answer_is_never_reviewed_and_uses_the_fixed_categories(
    engine: Engine, ibuprofen_otc: Label
) -> None:
    with serve(engine, FakeJev()) as client:
        answer = ask(client, IBUPROFEN, ibuprofen_otc.set_id).json()["answer"]
    assert answer["question"] == GRAPEFRUIT
    assert answer["status"] == "judged"
    assert answer["reviewed"] is False
    assert list(answer["stance"]["probabilities"]) == list(STANCES)


def test_the_quote_is_a_verbatim_candidate(engine: Engine, ibuprofen_otc: Label) -> None:
    candidate = build_custom_request(ibuprofen_otc, GRAPEFRUIT).asked[CUSTOM][3]
    jev = FakeJev(pick=lambda key, options: candidate.id if candidate.id in options else options[0])
    with serve(engine, jev) as client:
        evidence = ask(client, IBUPROFEN, ibuprofen_otc.set_id).json()["answer"]["evidence"]
    assert evidence["choice"] == candidate.id
    assert evidence["quote"] == {
        "section": candidate.section,
        "text": candidate.text,
        "lead_in": candidate.lead_in.text if candidate.lead_in else None,
    }


def test_every_ask_calls_jev_again(engine: Engine, ibuprofen_otc: Label) -> None:
    jev = FakeJev()
    with serve(engine, jev) as client:
        ask(client, IBUPROFEN, ibuprofen_otc.set_id)
        ask(client, IBUPROFEN, ibuprofen_otc.set_id)
    assert len(jev.requests) == 2


@pytest.mark.parametrize(("confidence", "expected"), [(0.95, True), (0.85, False)])
def test_confident_follows_the_display_threshold(
    engine: Engine, ibuprofen_otc: Label, confidence: float, expected: bool
) -> None:
    with serve(engine, FakeJev(confidence=lambda key: confidence)) as client:
        answer = ask(client, IBUPROFEN, ibuprofen_otc.set_id).json()["answer"]
    assert answer["confident"] is expected


def test_evidence_none_is_never_confident(engine: Engine, ibuprofen_otc: Label) -> None:
    jev = FakeJev(pick=lambda key, options: NONE if NONE in options else options[0])
    with serve(engine, jev) as client:
        app.dependency_overrides[get_settings] = lambda: Settings(
            _env_file=None, display_min_confidence=0.5
        )
        answer = ask(client, IBUPROFEN, ibuprofen_otc.set_id).json()["answer"]
    assert answer["evidence"]["quote"] is None
    assert answer["confident"] is False


def test_a_set_id_that_is_not_a_canonical_label_is_404(engine: Engine) -> None:
    jev = FakeJev()
    with serve(engine, jev) as client:
        response = ask(client, METFORMIN, "not-a-label")
    assert response.status_code == 404
    assert response.headers["content-type"] == PROBLEM_JSON
    assert jev.requests == []


def test_jev_failure_is_503(engine: Engine, ibuprofen_otc: Label) -> None:
    with serve(engine, FakeJev(status=529)) as client:
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id)
    assert response.status_code == 503
    assert response.headers["content-type"] == PROBLEM_JSON


def test_a_blank_question_is_422(engine: Engine, ibuprofen_otc: Label) -> None:
    jev = FakeJev()
    with serve(engine, jev) as client:
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id, question="   ")
    assert response.status_code == 422
    assert response.headers["content-type"] == PROBLEM_JSON
    assert jev.requests == []
