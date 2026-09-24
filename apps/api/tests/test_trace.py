"""The trace fields the transparency panel shows: sources, Jev runs and candidates."""

from collections.abc import Iterator

import pytest
from sqlalchemy import Engine

from rx_jev_api.clients.openfda import Label
from rx_jev_api.db import make_engine
from rx_jev_api.deps import get_ask_limiter, get_openfda_client
from rx_jev_api.judge import CUSTOM, build_custom_request, build_request
from rx_jev_api.main import app
from rx_jev_api.ratelimit import RateLimiter
from tests.jev import FakeJev
from tests.test_answers_api import IBUPROFEN, METFORMIN, OneLabel, serve


@pytest.fixture
def engine() -> Engine:
    return make_engine("sqlite://")


@pytest.fixture(autouse=True)
def unlimited() -> Iterator[None]:
    app.dependency_overrides[get_ask_limiter] = lambda: RateLimiter([])
    yield
    app.dependency_overrides.pop(get_ask_limiter, None)


def test_answers_report_the_sources_behind_the_lookup(engine: Engine) -> None:
    with serve(engine, FakeJev()) as client:
        sources = client.get(f"/api/labels/{IBUPROFEN}/answers").json()["sources"]
    assert sources["openfda_requests"] == 2
    assert sources["matches"] == {
        "otc": {"total": 831, "original_packager": True},
        "prescription": {"total": 47, "original_packager": True},
    }
    assert sources["rxnorm_ms"] >= 0
    assert sources["openfda_ms"] >= 0


def test_a_label_judged_now_reports_its_run_as_fresh(engine: Engine) -> None:
    with serve(engine, FakeJev()) as client:
        label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    assert label["fresh"] is True
    assert (label["input_tokens"], label["output_tokens"]) == (1234, 56)
    assert label["latency_ms"] >= 0


def test_a_label_from_the_store_keeps_its_run_but_is_not_fresh(engine: Engine) -> None:
    jev = FakeJev()
    with serve(engine, jev) as client:
        client.get(f"/api/labels/{METFORMIN}/answers")
        label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    assert len(jev.requests) == 1
    assert label["fresh"] is False
    assert (label["input_tokens"], label["output_tokens"]) == (1234, 56)


def test_a_label_never_sent_to_jev_has_no_run(engine: Engine, metformin_rx: Label) -> None:
    label = metformin_rx.model_copy(
        update={
            "sections": {"indications_and_usage": metformin_rx.sections["indications_and_usage"]}
        }
    )
    with serve(engine, FakeJev()) as client:
        app.dependency_overrides[get_openfda_client] = lambda: OneLabel(label)
        served = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    assert served["fresh"] is False
    assert (served["input_tokens"], served["output_tokens"], served["latency_ms"]) == (
        None,
        None,
        None,
    )


def test_each_answer_says_how_many_sentences_jev_chose_from(
    engine: Engine, metformin_rx: Label
) -> None:
    request = build_request(metformin_rx)
    with serve(engine, FakeJev()) as client:
        label = client.get(f"/api/labels/{METFORMIN}/answers").json()["labels"][0]
    for answer in label["answers"]:
        candidates = request.asked[answer["question_id"]]
        assert answer["candidates"] == len(candidates)
        assert answer["sections"] == list(dict.fromkeys(c.section for c in candidates))


def test_a_skipped_answer_offered_no_sentences(engine: Engine) -> None:
    with serve(engine, FakeJev()) as client:
        otc = client.get(f"/api/labels/{IBUPROFEN}/answers").json()["labels"][0]
    boxed = next(a for a in otc["answers"] if a["question_id"] == "boxed_warning")
    assert boxed["status"] == "no_sections"
    assert (boxed["candidates"], boxed["sections"]) == (0, [])


def test_a_custom_question_reports_its_live_run_and_sources(
    engine: Engine, ibuprofen_otc: Label
) -> None:
    question = "Can I drink grapefruit juice while taking this?"
    with serve(engine, FakeJev()) as client:
        body = client.post(
            f"/api/labels/{IBUPROFEN}/ask",
            json={"set_id": ibuprofen_otc.set_id, "question": question},
        ).json()
    candidates = build_custom_request(ibuprofen_otc, question).asked[CUSTOM]
    assert (body["input_tokens"], body["output_tokens"]) == (1234, 56)
    assert body["latency_ms"] >= 0
    assert body["sources"]["openfda_requests"] == 2
    assert body["answer"]["candidates"] == len(candidates)
    assert body["answer"]["sections"] == list(dict.fromkeys(c.section for c in candidates))
