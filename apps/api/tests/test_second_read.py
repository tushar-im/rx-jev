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
    load_candidate_ids,
    packet,
    read_grades,
    write_packet_batches,
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


@pytest.fixture
def ids(rows: list[ReviewRow], metformin_rx: Label) -> dict[str, set[str]]:
    """Each row's candidate sentence IDs, as its packet offers them."""
    return {r.row_id: {c["id"] for c in packet(r, metformin_rx)["candidates"]} for r in rows}


def test_agreement_on_stance_and_sentence(rows: list[ReviewRow], ids: dict[str, set[str]]) -> None:
    [result] = compare(rows[:1], [grade(rows[0])], ids)
    assert (result.stance_agrees, result.evidence) == (True, "same")
    assert result.needs_human is False


def test_a_different_stance_needs_a_human(rows: list[ReviewRow], ids: dict[str, set[str]]) -> None:
    other = "caution" if rows[0].stance != "caution" else "dose_change"
    [result] = compare(rows[:1], [grade(rows[0], stance=other)], ids)
    assert result.stance_agrees is False
    assert result.needs_human is True


def test_a_different_supporting_sentence_is_not_escalated(
    rows: list[ReviewRow], ids: dict[str, set[str]]
) -> None:
    other = sorted(ids[rows[0].row_id] - {rows[0].evidence})[0]
    [result] = compare(rows[:1], [grade(rows[0], evidence=other)], ids)
    assert result.evidence == "other_sentence"
    assert result.needs_human is False


def test_sentence_against_none_needs_a_human(
    rows: list[ReviewRow], ids: dict[str, set[str]]
) -> None:
    [result] = compare(rows[:1], [grade(rows[0], evidence=NONE)], ids)
    assert result.evidence == "none_mismatch"
    assert result.needs_human is True


def test_rows_without_a_grade_are_reported_ungraded(
    rows: list[ReviewRow], ids: dict[str, set[str]]
) -> None:
    results = compare(rows[:2], [grade(rows[0])], ids)
    assert [r.graded for r in results] == [True, False]
    assert results[1].needs_human is True


def test_duplicate_grades_for_a_row_are_rejected(
    rows: list[ReviewRow], ids: dict[str, set[str]]
) -> None:
    other = "caution" if rows[0].stance != "caution" else "dose_change"
    duplicate = [grade(rows[0]), grade(rows[0], stance=other)]
    with pytest.raises(ValueError, match=rows[0].row_id):
        compare(rows[:1], duplicate, ids)


def test_evidence_that_is_not_a_candidate_of_the_row_is_rejected(
    rows: list[ReviewRow], ids: dict[str, set[str]]
) -> None:
    with pytest.raises(ValueError, match="made-up-id"):
        compare(rows[:1], [grade(rows[0], evidence="made-up-id")], ids)


def item(row_id: str, *ids: str) -> dict:
    return {"row_id": row_id, "candidates": [{"id": i, "text": "x" * 10} for i in ids]}


def test_writing_packets_removes_batches_from_an_earlier_sheet(tmp_path: Path) -> None:
    (tmp_path / "007.json").write_text(json.dumps([item("stale", "s9")]))
    count = write_packet_batches(tmp_path, [item("a", "s1"), item("b", "s2")], batch_chars=10)
    assert count == 2
    assert sorted(p.name for p in tmp_path.glob("*.json")) == ["001.json", "002.json"]


def test_candidate_ids_are_loaded_for_exactly_the_current_rows(tmp_path: Path) -> None:
    write_packet_batches(tmp_path, [item("a", "s1", "s2"), item("b", "s3")], batch_chars=100)
    assert load_candidate_ids(tmp_path, ["a", "b"]) == {"a": {"s1", "s2"}, "b": {"s3"}}


def test_a_row_in_two_packets_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "001.json").write_text(json.dumps([item("a", "s1")]))
    (tmp_path / "002.json").write_text(json.dumps([item("a", "s2")]))
    with pytest.raises(ValueError, match="a"):
        load_candidate_ids(tmp_path, ["a"])


def test_packets_for_rows_not_in_the_sheet_are_rejected(tmp_path: Path) -> None:
    (tmp_path / "001.json").write_text(json.dumps([item("a", "s1"), item("old", "s2")]))
    with pytest.raises(ValueError, match="old"):
        load_candidate_ids(tmp_path, ["a"])


def test_sheet_rows_without_a_packet_are_rejected(tmp_path: Path) -> None:
    (tmp_path / "001.json").write_text(json.dumps([item("a", "s1")]))
    with pytest.raises(ValueError, match="b"):
        load_candidate_ids(tmp_path, ["a", "b"])


def test_read_grades_merges_batch_files_and_rejects_bad_stances(tmp_path: Path) -> None:
    good = {"row_id": "a", "stance": "caution", "evidence": "s1", "note": ""}
    (tmp_path / "001.json").write_text(json.dumps([good]))
    (tmp_path / "002.json").write_text(json.dumps([good | {"row_id": "b"}]))
    assert [g.row_id for g in read_grades(tmp_path)] == ["a", "b"]

    (tmp_path / "003.json").write_text(json.dumps([good | {"stance": "safe"}]))
    with pytest.raises(ValueError):
        read_grades(tmp_path)
