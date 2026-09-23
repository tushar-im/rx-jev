import csv
import json
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlmodel import Session

from rx_jev_api.answering import JudgedLabel, judge_labels
from rx_jev_api.catalog import candidate_sections, get_question
from rx_jev_api.clients.openfda import Label
from rx_jev_api.db import make_engine
from rx_jev_api.judge import NONE, Judge
from rx_jev_api.review import (
    REVIEW_COLUMNS,
    ReviewRow,
    confidence_band,
    flags,
    label_rows,
    select_rows,
    write_csv,
    write_json,
)
from rx_jev_api.store import Store
from tests.jev import FakeJev


@pytest.fixture
def store() -> Iterator[Store]:
    with Session(make_engine("sqlite://")) as session:
        yield Store(session)


def judged(label: Label, store: Store, jev: FakeJev | None = None) -> JudgedLabel:
    [result] = judge_labels([label], Judge((jev or FakeJev()).client(), "jev-latest"), store)
    return result


def row(
    n: int,
    stance: str = "caution",
    stance_conf: float = 0.99,
    evidence: str = "s1",
    evidence_conf: float = 0.95,
) -> ReviewRow:
    return ReviewRow(
        row_id=f"set:{n}",
        drug="metformin",
        product_type="prescription",
        set_id="set",
        version="1",
        dailymed_url="https://dailymed.test",
        question_id="kidney",
        title="Kidney disease",
        subject="kidney disease",
        sections=["warnings"],
        stance=stance,
        stance_confidence=stance_conf,
        evidence=evidence,
        evidence_confidence=evidence_conf,
        quote_section=None if evidence == NONE else "warnings",
        quote_lead_in=None,
        quote_text=None if evidence == NONE else "A sentence.",
        reasons=[],
    )


def test_one_row_per_judged_question_with_its_quote(metformin_rx: Label, store: Store) -> None:
    j = judged(metformin_rx, store)
    rows = label_rows("metformin", j)

    assert [r.question_id for r in rows] == list(j.request.asked)
    first = rows[0]
    question = get_question(first.question_id)
    assert first.row_id == f"{metformin_rx.set_id}:{first.question_id}"
    assert (first.drug, first.set_id, first.version) == (
        "metformin",
        metformin_rx.set_id,
        metformin_rx.version,
    )
    assert first.sections == candidate_sections(first.question_id, metformin_rx)
    assert first.subject == question.subject
    assert first.dailymed_url == metformin_rx.dailymed_url
    assert first.stance == "warns_against"
    assert first.quote_text is not None
    assert first.quote_text in metformin_rx.sections[first.quote_section or ""]


def test_skipped_questions_have_no_rows(ibuprofen_otc: Label, store: Store) -> None:
    rows = label_rows("ibuprofen", judged(ibuprofen_otc, store))
    assert "boxed_warning" not in {r.question_id for r in rows}


@pytest.mark.parametrize(
    ("stance", "stance_conf", "evidence", "evidence_conf", "expected"),
    [
        ("caution", 0.99, "s1", 0.95, []),
        ("caution", 0.3, "s1", 0.3, []),
        ("no_known_issue", 0.99, "s1", 0.95, ["no_known_issue"]),
        ("not_mentioned", 0.99, "s1", 0.95, ["stance_evidence_mismatch"]),
        ("caution", 0.99, NONE, 0.95, ["stance_evidence_mismatch"]),
        ("not_mentioned", 0.99, NONE, 0.95, []),
        ("no_known_issue", 0.5, NONE, 0.5, ["no_known_issue", "stance_evidence_mismatch"]),
    ],
)
def test_flags(
    stance: str, stance_conf: float, evidence: str, evidence_conf: float, expected: list[str]
) -> None:
    assert flags(row(0, stance, stance_conf, evidence, evidence_conf)) == expected


@pytest.mark.parametrize(
    ("stance_conf", "evidence_conf", "expected"),
    [(0.99, 0.95, 3), (0.95, 0.85, 2), (0.6, 0.99, 1), (0.99, 0.2, 0), (0.9, 0.7, 2)],
)
def test_band_is_set_by_the_weaker_confidence(
    stance_conf: float, evidence_conf: float, expected: int
) -> None:
    assert confidence_band(row(0, stance_conf=stance_conf, evidence_conf=evidence_conf)) == expected


def test_selection_keeps_every_flagged_row_and_samples_each_band() -> None:
    flagged = [row(n, stance="no_known_issue", stance_conf=0.99) for n in range(5)]
    # 50 plain rows in each of the four bands.
    confidences = [0.3, 0.6, 0.8, 0.99]
    plain = [row(100 + n, stance_conf=confidences[n % 4]) for n in range(200)]

    selected = select_rows(flagged + plain, per_band=10, seed=7)

    kept = [r for r in selected if r.reasons != ["sample"]]
    assert [r.row_id for r in kept] == [r.row_id for r in flagged]
    assert all(r.reasons == ["no_known_issue"] for r in kept)
    sampled = [r for r in selected if r.reasons == ["sample"]]
    assert sorted(Counter(confidence_band(r) for r in sampled).items()) == [
        (0, 10),
        (1, 10),
        (2, 10),
        (3, 10),
    ]
    assert select_rows(flagged + plain, per_band=10, seed=7) == selected
    assert select_rows(flagged + plain, per_band=10, seed=8) != selected


def test_a_band_with_fewer_rows_than_asked_is_taken_whole() -> None:
    rows = [row(n, stance_conf=0.3) for n in range(4)]
    assert len(select_rows(rows, per_band=10, seed=1)) == 4


def test_selected_rows_keep_label_order() -> None:
    rows = [row(n, stance="no_known_issue" if n % 3 == 0 else "caution") for n in range(30)]
    selected = select_rows(rows, per_band=5, seed=1)
    order = [r.row_id for r in rows]
    assert [r.row_id for r in selected] == sorted((r.row_id for r in selected), key=order.index)


def test_csv_has_row_fields_then_blank_review_columns(tmp_path: Path) -> None:
    path = tmp_path / "sheet.csv"
    flagged = row(0, stance="no_known_issue").model_copy(update={"reasons": ["no_known_issue"]})
    write_csv(path, [flagged])

    with path.open(newline="") as f:
        [record] = list(csv.DictReader(f))
    assert list(record)[-len(REVIEW_COLUMNS) :] == list(REVIEW_COLUMNS)
    assert all(record[c] == "" for c in REVIEW_COLUMNS)
    assert record["stance"] == "no_known_issue"
    assert record["reasons"] == "no_known_issue"
    assert record["sections"] == "warnings"


def test_json_round_trips_rows(tmp_path: Path) -> None:
    path = tmp_path / "sheet.json"
    rows = [row(0), row(1, evidence=NONE)]
    write_json(path, rows)
    assert [ReviewRow.model_validate(r) for r in json.loads(path.read_text())] == rows
