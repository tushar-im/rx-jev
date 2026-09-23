import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlmodel import Session

from rx_jev_api.answering import judge_labels
from rx_jev_api.clients.openfda import Label
from rx_jev_api.db import make_engine
from rx_jev_api.judge import NONE, Judge
from rx_jev_api.review import ReviewRow, label_rows
from rx_jev_api.second_read import (
    Grade,
    compare,
    packet,
    read_grades,
)
from rx_jev_api.store import Store
from tests.jev import FakeJev


@pytest.fixture
def store() -> Iterator[Store]:
    with Session(make_engine("sqlite://")) as session:
        yield Store(session)


@pytest.fixture
def rows(metformin_rx: Label, store: Store) -> list[ReviewRow]:
    [judged] = judge_labels([metformin_rx], Judge(FakeJev().client(), "jev-latest"), store)
    return label_rows("metformin", judged)


def test_packet_holds_the_sentences_but_not_jev_s_answer(
    rows: list[ReviewRow], metformin_rx: Label
) -> None:
    row = rows[0]
    item = packet(row, metformin_rx)

    assert item["row_id"] == row.row_id
    assert item["subject"] == row.subject
    assert item["sections"] == row.sections
    assert all(c["section"] in row.sections for c in item["candidates"])
    assert any(c["id"] == row.evidence for c in item["candidates"])
    text = json.dumps(item)
    for hidden in ("stance", "confidence", "evidence", "reasons"):
        assert f'"{hidden}' not in text


def grade(row: ReviewRow, stance: str | None = None, evidence: str | None = None) -> Grade:
    return Grade(
        row_id=row.row_id,
        stance=stance or row.stance,
        evidence=evidence or row.evidence,
        note="",
    )


def test_agreement_on_stance_and_sentence(rows: list[ReviewRow]) -> None:
    [result] = compare(rows[:1], [grade(rows[0])])
    assert (result.stance_agrees, result.evidence) == (True, "same")
    assert result.needs_human is False


def test_a_different_stance_needs_a_human(rows: list[ReviewRow]) -> None:
    other = "caution" if rows[0].stance != "caution" else "dose_change"
    [result] = compare(rows[:1], [grade(rows[0], stance=other)])
    assert result.stance_agrees is False
    assert result.needs_human is True


def test_a_different_supporting_sentence_is_not_escalated(rows: list[ReviewRow]) -> None:
    [result] = compare(rows[:1], [grade(rows[0], evidence="some-other-id")])
    assert result.evidence == "other_sentence"
    assert result.needs_human is False


def test_sentence_against_none_needs_a_human(rows: list[ReviewRow]) -> None:
    [result] = compare(rows[:1], [grade(rows[0], evidence=NONE)])
    assert result.evidence == "none_mismatch"
    assert result.needs_human is True


def test_rows_without_a_grade_are_reported_ungraded(rows: list[ReviewRow]) -> None:
    results = compare(rows[:2], [grade(rows[0])])
    assert [r.graded for r in results] == [True, False]
    assert results[1].needs_human is True


def test_read_grades_merges_batch_files_and_rejects_bad_stances(tmp_path: Path) -> None:
    good = {"row_id": "a", "stance": "caution", "evidence": "s1", "note": ""}
    (tmp_path / "001.json").write_text(json.dumps([good]))
    (tmp_path / "002.json").write_text(json.dumps([good | {"row_id": "b"}]))
    assert [g.row_id for g in read_grades(tmp_path)] == ["a", "b"]

    (tmp_path / "003.json").write_text(json.dumps([good | {"stance": "safe"}]))
    with pytest.raises(ValueError):
        read_grades(tmp_path)
