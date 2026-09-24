from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import Engine

from rx_jev_api.clients.openfda import Label
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.config import Settings, get_settings
from rx_jev_api.db import make_engine
from rx_jev_api.deps import get_ask_limiter, get_rxnorm_client
from rx_jev_api.judge import CUSTOM, NONE, STANCES, build_custom_request
from rx_jev_api.main import app
from rx_jev_api.problems import PROBLEM_JSON
from rx_jev_api.ratelimit import Limit, RateLimiter
from rx_jev_api.routers.ask import MAX_QUESTION_CHARS, MIN_QUESTION_CHARS
from tests.jev import MODEL_VERSION, FakeJev
from tests.test_answers_api import IBUPROFEN, METFORMIN, runs, serve

GRAPEFRUIT = "Can I drink grapefruit juice while taking this?"


@pytest.fixture
def engine() -> Engine:
    return make_engine("sqlite://")


@pytest.fixture(autouse=True)
def unlimited() -> Iterator[None]:
    # The app's limiter lives for the whole process; each test starts with no limit.
    app.dependency_overrides[get_ask_limiter] = lambda: RateLimiter([])
    yield
    app.dependency_overrides.pop(get_ask_limiter, None)


def unreachable() -> httpx.Client:
    def fail(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected upstream request: {request.url}")

    return httpx.Client(transport=httpx.MockTransport(fail))


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
    for question in jev.requests[0]["questions"].values():
        assert question["instructions"]["reader_question"] == GRAPEFRUIT


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


@pytest.mark.parametrize(
    "question", ["ab", "x" * (MAX_QUESTION_CHARS + 1)], ids=["too short", "too long"]
)
def test_question_length_is_limited(engine: Engine, ibuprofen_otc: Label, question: str) -> None:
    jev = FakeJev()
    with serve(engine, jev) as client:
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id, question=question)
    assert response.status_code == 422
    assert response.headers["content-type"] == PROBLEM_JSON
    assert jev.requests == []


def test_question_length_limits() -> None:
    assert (MIN_QUESTION_CHARS, MAX_QUESTION_CHARS) == (3, 200)


def test_a_question_at_the_length_limit_is_asked(engine: Engine, ibuprofen_otc: Label) -> None:
    with serve(engine, FakeJev()) as client:
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id, question="x" * MAX_QUESTION_CHARS)
    assert response.status_code == 200


def test_asks_over_the_rate_limit_are_429_without_calling_jev(
    engine: Engine, ibuprofen_otc: Label
) -> None:
    jev = FakeJev()
    limiter = RateLimiter([Limit(count=2, seconds=60)])
    with serve(engine, jev) as client:
        app.dependency_overrides[get_ask_limiter] = lambda: limiter
        statuses = [ask(client, IBUPROFEN, ibuprofen_otc.set_id).status_code for _ in range(2)]
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id)
    assert statuses == [200, 200]
    assert response.status_code == 429
    assert response.headers["content-type"] == PROBLEM_JSON
    assert 1 <= int(response.headers["retry-after"]) <= 60
    assert "Try again" in response.json()["detail"]
    assert len(jev.requests) == 2


def test_invalid_asks_do_not_use_up_the_limit(engine: Engine, ibuprofen_otc: Label) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)])
    with serve(engine, FakeJev()) as client:
        app.dependency_overrides[get_ask_limiter] = lambda: limiter
        ask(client, IBUPROFEN, ibuprofen_otc.set_id, question="ab")
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id)
    assert response.status_code == 200


def test_asks_about_an_unknown_label_do_not_use_up_the_limit(
    engine: Engine, ibuprofen_otc: Label
) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)])
    with serve(engine, FakeJev()) as client:
        app.dependency_overrides[get_ask_limiter] = lambda: limiter
        assert ask(client, IBUPROFEN, "not-a-label").status_code == 404
        assert ask(client, "0", ibuprofen_otc.set_id).status_code == 404
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id)
    assert response.status_code == 200


def test_a_spent_limit_is_429_before_any_upstream_call(
    engine: Engine, ibuprofen_otc: Label
) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)])
    limiter.hit("testclient")
    with serve(engine, FakeJev()) as client:
        app.dependency_overrides[get_ask_limiter] = lambda: limiter
        app.dependency_overrides[get_rxnorm_client] = lambda: RxNormClient(unreachable())
        response = ask(client, IBUPROFEN, ibuprofen_otc.set_id)
    assert response.status_code == 429


@pytest.mark.parametrize("field", ["ask_per_minute", "ask_per_day"])
def test_ask_limits_must_allow_at_least_one(field: str) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: 0})


def test_default_ask_limits() -> None:
    settings = Settings(_env_file=None)
    assert (settings.ask_per_minute, settings.ask_per_day) == (5, 50)
