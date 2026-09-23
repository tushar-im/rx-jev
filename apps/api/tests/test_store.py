from collections.abc import Iterator

import pytest
from sqlmodel import Session, select

from rx_jev_api.clients.openfda import Label
from rx_jev_api.db import make_engine
from rx_jev_api.judge import Judge, JudgeRequest, JudgeResult, build_request
from rx_jev_api.store import JudgmentRecord, Store
from tests.jev import MODEL_VERSION, FakeJev

MODEL = "jev-latest"


@pytest.fixture
def session() -> Iterator[Session]:
    with Session(make_engine("sqlite://")) as session:
        yield session


@pytest.fixture
def judged(metformin_rx: Label) -> tuple[JudgeRequest, JudgeResult]:
    request = build_request(metformin_rx)
    return request, Judge(FakeJev().client(), MODEL).judge(request)


def test_miss_on_empty_store(session: Session, metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    assert Store(session).find(metformin_rx, request.prompt_hash, MODEL) is None


def test_saved_judgments_round_trip_with_full_distributions(
    session: Session, metformin_rx: Label, judged: tuple[JudgeRequest, JudgeResult]
) -> None:
    request, result = judged
    Store(session).save(metformin_rx, request, MODEL, result)

    stored = Store(session).find(metformin_rx, request.prompt_hash, MODEL)
    assert stored is not None
    assert stored.model_version == MODEL_VERSION
    assert set(stored.judgments) == set(result.distributions)
    for key, distribution in result.distributions.items():
        assert stored.judgments[key].distribution == distribution
        assert stored.judgments[key].reviewed is False


def test_one_row_per_question_and_kind(
    session: Session, metformin_rx: Label, judged: tuple[JudgeRequest, JudgeResult]
) -> None:
    request, result = judged
    Store(session).save(metformin_rx, request, MODEL, result)
    rows = session.exec(select(JudgmentRecord)).all()
    assert len(rows) == len(result.distributions)
    pregnancy = {r.kind for r in rows if r.question_id == "pregnancy"}
    assert pregnancy == {"stance", "evidence"}


def test_run_records_latency_tokens_and_hash(
    session: Session, metformin_rx: Label, judged: tuple[JudgeRequest, JudgeResult]
) -> None:
    request, result = judged
    stored = Store(session).save(metformin_rx, request, MODEL, result)
    assert stored.prompt_hash == request.prompt_hash
    assert stored.model == MODEL
    assert (stored.input_tokens, stored.output_tokens) == (1234, 56)
    assert stored.latency_ms == result.latency_ms


@pytest.mark.parametrize(
    "change",
    [
        {"prompt_hash": "other"},
        {"model": "jev-1.0.0"},
        {"version": "999"},
        {"set_id": "other-set"},
    ],
)
def test_miss_when_any_key_part_differs(
    session: Session,
    metformin_rx: Label,
    judged: tuple[JudgeRequest, JudgeResult],
    change: dict[str, str],
) -> None:
    request, result = judged
    Store(session).save(metformin_rx, request, MODEL, result)
    label = metformin_rx.model_copy(
        update={k: v for k, v in change.items() if k in ("version", "set_id")}
    )
    found = Store(session).find(
        label, change.get("prompt_hash", request.prompt_hash), change.get("model", MODEL)
    )
    assert found is None


def test_saving_the_same_key_twice_keeps_the_first_run(
    session: Session, metformin_rx: Label, judged: tuple[JudgeRequest, JudgeResult]
) -> None:
    request, result = judged
    first = Store(session).save(metformin_rx, request, MODEL, result)
    second = Store(session).save(metformin_rx, request, MODEL, result)
    assert second.id == first.id
    assert len(session.exec(select(JudgmentRecord)).all()) == len(result.distributions)


def test_label_json_is_kept_for_review(
    session: Session, metformin_rx: Label, judged: tuple[JudgeRequest, JudgeResult]
) -> None:
    request, result = judged
    Store(session).save(metformin_rx, request, MODEL, result)
    assert Store(session).label(metformin_rx.set_id, metformin_rx.version) == metformin_rx
