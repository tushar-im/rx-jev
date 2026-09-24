"""Builds the Gate 1 review sheet from stored judgments (G1.2).

One row per label and judged question, built from the same answers the API serves. Every
flagged row is kept. The rest are sampled evenly across confidence bands, so accuracy can
be measured at every confidence level without reading every answer. See
docs/gate-1-review-rules.md for how rows are marked.
"""

import csv
import json
import random
from collections import defaultdict
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from rx_jev_api.answering import JudgedLabel
from rx_jev_api.catalog import QuestionId, candidate_sections, get_question
from rx_jev_api.clients.openfda import ProductType
from rx_jev_api.judge import NONE
from rx_jev_api.routers.answers import label_answers

__all__ = [
    "BAND_EDGES",
    "REVIEW_COLUMNS",
    "Reason",
    "ReviewRow",
    "confidence_band",
    "flags",
    "label_rows",
    "select_rows",
    "write_csv",
    "write_json",
]

# Lower edges of confidence bands 1 to 3; band 0 is below the first. Used to choose rows to
# review, not to display answers: display thresholds come from the review itself.
BAND_EDGES = (0.5, 0.7, 0.9)

Reason = Literal["no_known_issue", "stance_evidence_mismatch", "sample"]

# Filled in by the reviewer, in this order after the row's own fields.
REVIEW_COLUMNS = (
    "stance_ok",
    "correct_stance",
    "evidence_ok",
    "better_sentence",
    "unsure",
    "error_type",
    "notes",
)


class ReviewRow(BaseModel, frozen=True):
    row_id: str
    drug: str
    product_type: ProductType
    set_id: str
    version: str
    dailymed_url: str
    question_id: QuestionId
    title: str
    subject: str
    sections: list[str]
    stance: str
    stance_confidence: float
    evidence: str
    evidence_confidence: float
    quote_section: str | None
    quote_lead_in: str | None
    quote_text: str | None
    # Why the row is in the sheet.
    reasons: list[Reason]


def label_rows(drug: str, judged: JudgedLabel) -> list[ReviewRow]:
    """One row per judged question of the label, in catalog order."""
    served = label_answers(judged)
    rows: list[ReviewRow] = []
    for answer in served.answers:
        if answer.status != "judged" or answer.stance is None or answer.evidence is None:
            continue
        quote = answer.evidence.quote
        rows.append(
            ReviewRow(
                row_id=f"{served.set_id}:{answer.question_id}",
                drug=drug,
                product_type=served.product_type,
                set_id=served.set_id,
                version=served.version,
                dailymed_url=served.dailymed_url,
                question_id=answer.question_id,
                title=answer.title,
                subject=get_question(answer.question_id).subject,
                sections=candidate_sections(answer.question_id, judged.label),
                stance=answer.stance.choice,
                stance_confidence=answer.stance.confidence,
                evidence=answer.evidence.choice,
                evidence_confidence=answer.evidence.confidence,
                quote_section=quote.section if quote else None,
                quote_lead_in=quote.lead_in if quote else None,
                quote_text=quote.text if quote else None,
                reasons=[],
            )
        )
    return rows


def confidence_band(row: ReviewRow) -> int:
    """The band of the row's weaker confidence, 0 (lowest) to len(BAND_EDGES)."""
    weaker = min(row.stance_confidence, row.evidence_confidence)
    return sum(weaker >= edge for edge in BAND_EDGES)


def flags(row: ReviewRow) -> list[Reason]:
    """Why a row must be reviewed, whatever the sample."""
    reasons: list[Reason] = []
    if row.stance == "no_known_issue":
        reasons.append("no_known_issue")
    # `not_mentioned` should come with `none`, and any other stance with a sentence.
    if (row.stance == "not_mentioned") != (row.evidence == NONE):
        reasons.append("stance_evidence_mismatch")
    return reasons


def select_rows(rows: list[ReviewRow], per_band: int, seed: int) -> list[ReviewRow]:
    """Every flagged row plus up to `per_band` others from each band, in the input order."""
    reasons: dict[str, list[Reason]] = {r.row_id: flags(r) for r in rows}
    bands: dict[int, list[str]] = defaultdict(list)
    for r in rows:
        if not reasons[r.row_id]:
            bands[confidence_band(r)].append(r.row_id)
    rng = random.Random(seed)
    for band in sorted(bands):
        plain = bands[band]
        for row_id in rng.sample(plain, min(per_band, len(plain))):
            reasons[row_id] = ["sample"]
    return [r.model_copy(update={"reasons": reasons[r.row_id]}) for r in rows if reasons[r.row_id]]


def write_csv(path: Path, rows: list[ReviewRow]) -> None:
    fields = list(ReviewRow.model_fields)
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[*fields, *REVIEW_COLUMNS])
        writer.writeheader()
        for row in rows:
            record: dict[str, object] = row.model_dump()
            record["sections"] = ", ".join(row.sections)
            record["reasons"] = ", ".join(row.reasons)
            writer.writerow(record | dict.fromkeys(REVIEW_COLUMNS, ""))


def write_json(path: Path, rows: list[ReviewRow]) -> None:
    path.write_text(json.dumps([r.model_dump() for r in rows], indent=2) + "\n")
