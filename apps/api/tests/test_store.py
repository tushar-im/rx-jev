from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import event
from sqlmodel import Session, select

from rx_jev_api.clients.openfda import Label
from rx_jev_api.db import make_engine
from rx_jev_api.judge import Judge, JudgeRequest, JudgeResult, build_request
from rx_jev_api.store import JudgmentRecord, LabelRecord, Store
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
    later = result.model_copy(
        update={
            "model_version": "jev-9.9.9",
            "latency_ms": result.latency_ms + 999,
            "distributions": {
                key: d.model_copy(update={"confidence": 0.01})
                for key, d in result.distributions.items()
            },
        }
    )
    second = Store(session).save(metformin_rx, request, MODEL, later)

    assert second == first
    assert Store(session).find(metformin_rx, request.prompt_hash, MODEL) == first
    assert first.model_version == MODEL_VERSION
    assert len(session.exec(select(JudgmentRecord)).all()) == len(result.distributions)


def test_a_rival_writer_storing_the_label_row_does_not_lose_a_distinct_run(
    tmp_path: Path, metformin_rx: Label, judged: tuple[JudgeRequest, JudgeResult]
) -> None:
    # Two deployments judge the same label version under different prompt hashes. The rival
    # commits the shared label row after this writer checked for it, before it flushes.
    engine = make_engine(f"sqlite:///{tmp_path / 'race.db'}")
    request, result = judged
    fired = False

    with Session(engine) as session:

        @event.listens_for(session, "before_flush")
        def rival(*_: object) -> None:
            nonlocal fired
            if fired:
                return
            fired = True
            with Session(engine) as other:
                other.add(
                    LabelRecord(
                        set_id=metformin_rx.set_id,
                        version=metformin_rx.version,
                        raw=metformin_rx.model_dump(mode="json"),
                    )
                )
                other.commit()

        stored = Store(session).save(metformin_rx, request, MODEL, result)

    assert fired
    assert stored.prompt_hash == request.prompt_hash
    with Session(engine) as check:
        assert Store(check).find(metformin_rx, request.prompt_hash, MODEL) == stored
        assert len(check.exec(select(JudgmentRecord)).all()) == len(result.distributions)


def test_one_label_row_serves_runs_under_different_keys(
    session: Session, metformin_rx: Label, judged: tuple[JudgeRequest, JudgeResult]
) -> None:
    request, result = judged
    first = Store(session).save(metformin_rx, request, MODEL, result)
    other = request.model_copy(update={"prompt_hash": "other-prompt"})
    second = Store(session).save(metformin_rx, other, MODEL, result)
    assert second.id != first.id
    assert len(session.exec(select(LabelRecord)).all()) == 1


def test_label_json_is_kept_for_review(
    session: Session, metformin_rx: Label, judged: tuple[JudgeRequest, JudgeResult]
) -> None:
    request, result = judged
    Store(session).save(metformin_rx, request, MODEL, result)
    assert Store(session).label(metformin_rx.set_id, metformin_rx.version) == metformin_rx
