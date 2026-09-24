"""A blind second read of the Gate 1 review sheet (G1.3).

Claude grades each row from packets that hold the row's candidate sentences but not Jev's
answer. Comparing the two readings leaves the owner only the rows where they disagree on
what the label says. A different sentence supporting the same stance is not escalated: the
review rules accept any sentence that supports the correct stance.
"""

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ValidationError

from rx_jev_api.clients.openfda import Label
from rx_jev_api.judge import NONE, Stance
from rx_jev_api.review import ReviewRow
from rx_jev_api.sentences import label_candidates

__all__ = [
    "Comparison",
    "EvidenceMatch",
    "Grade",
    "compare",
    "load_candidate_ids",
    "packet",
    "read_grades",
    "write_packet_batches",
]

# `same` sentence, an `other_sentence` (both real), or one side chose `none`.
EvidenceMatch = Literal["same", "other_sentence", "none_mismatch"]


class Grade(BaseModel, frozen=True):
    row_id: str
    stance: Stance
    # A candidate ID, or `none`.
    evidence: str
    note: str = ""


class Comparison(BaseModel, frozen=True):
    row: ReviewRow
    grade: Grade | None
    graded: bool
    stance_agrees: bool
    evidence: EvidenceMatch | None
    # True when the owner must decide: the readings disagree, or the row is ungraded.
    needs_human: bool


def packet(row: ReviewRow, label: Label) -> dict[str, Any]:
    """What the second reader sees for a row: the question and its sentences, no answer."""
    return {
        "row_id": row.row_id,
        "drug": row.drug,
        "product_type": row.product_type,
        "subject": row.subject,
        "sections": row.sections,
        "candidates": [
            {
                "id": c.id,
                "section": c.section,
                "lead_in": c.lead_in.text if c.lead_in else None,
                "text": c.text,
            }
            for c in label_candidates(label, row.sections)
        ],
    }


def write_packet_batches(directory: Path, items: list[dict[str, Any]], batch_chars: int) -> int:
    """Replace the directory's packet batches, so no batch from an earlier sheet survives.

    A batch closes once adding the next row would pass `batch_chars` of sentence text.
    Returns the number of batches written.
    """
    directory.mkdir(parents=True, exist_ok=True)
    for old in directory.glob("*.json"):
        old.unlink()

    batches: list[list[dict[str, Any]]] = [[]]
    size = 0
    for item in items:
        chars = sum(len(c["text"]) for c in item["candidates"])
        if batches[-1] and size + chars > batch_chars:
            batches.append([])
            size = 0
        batches[-1].append(item)
        size += chars
    for n, batch in enumerate(batches, start=1):
        path = directory / f"{n:03}.json"
        path.write_text(json.dumps(batch, indent=1, ensure_ascii=False))
    return len(batches)


def load_candidate_ids(directory: Path, row_ids: list[str]) -> dict[str, set[str]]:
    """Each current row's candidate IDs from the packets, which must match the sheet exactly.

    Raises ValueError for a row in two packets, a packet row not in the sheet (a stale
    batch), or a sheet row without a packet.
    """
    wanted = set(row_ids)
    ids: dict[str, set[str]] = {}
    for path in sorted(directory.glob("*.json")):
        for item in json.loads(path.read_text()):
            row_id = item["row_id"]
            if row_id in ids:
                raise ValueError(f"Row {row_id} appears in more than one packet ({path.name}).")
            if row_id not in wanted:
                raise ValueError(f"Packet {path.name} holds row {row_id}, not in the sheet.")
            ids[row_id] = {c["id"] for c in item["candidates"]}
    missing = [r for r in row_ids if r not in ids]
    if missing:
        raise ValueError(f"No packet for rows: {', '.join(missing)}.")
    return ids


def read_grades(directory: Path) -> list[Grade]:
    """Every grade in the directory's JSON batch files, in file order."""
    grades: list[Grade] = []
    for path in sorted(directory.glob("*.json")):
        try:
            grades.extend(Grade.model_validate(g) for g in json.loads(path.read_text()))
        except ValidationError as exc:
            raise ValueError(f"Bad grade in {path.name}: {exc}") from exc
    return grades


def compare(
    rows: list[ReviewRow], grades: list[Grade], candidate_ids: dict[str, set[str]]
) -> list[Comparison]:
    """Both readings of every row. `candidate_ids` holds each row's packet sentence IDs.

    Raises ValueError for a row graded twice, or evidence that is not one of the row's
    candidates: either would let a malformed grade pass as agreement.
    """
    by_row: dict[str, Grade] = {}
    for g in grades:
        if g.row_id in by_row:
            raise ValueError(f"Row {g.row_id} is graded more than once.")
        if g.evidence != NONE and g.evidence not in candidate_ids.get(g.row_id, set()):
            raise ValueError(f"Row {g.row_id} grades evidence {g.evidence}, not a candidate.")
        by_row[g.row_id] = g
    results: list[Comparison] = []
    for row in rows:
        grade = by_row.get(row.row_id)
        if grade is None:
            results.append(
                Comparison(
                    row=row,
                    grade=None,
                    graded=False,
                    stance_agrees=False,
                    evidence=None,
                    needs_human=True,
                )
            )
            continue
        stance_agrees = grade.stance == row.stance
        evidence = _evidence_match(row.evidence, grade.evidence)
        results.append(
            Comparison(
                row=row,
                grade=grade,
                graded=True,
                stance_agrees=stance_agrees,
                evidence=evidence,
                needs_human=not stance_agrees or evidence == "none_mismatch",
            )
        )
    return results


def _evidence_match(jev: str, claude: str) -> EvidenceMatch:
    if jev == claude:
        return "same"
    if NONE in (jev, claude):
        return "none_mismatch"
    return "other_sentence"
