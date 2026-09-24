"""Write golden files the TypeScript port must match byte for byte (M6.2).

Run from apps/api:

    uv run python scripts/write_golden.py [database.db]

For every label in the recorded test fixtures (fixtures/golden/fixtures.json, committed) and
every label in the store (fixtures/golden/store.jsonl, local only: it holds the whole store),
it writes what the Jev request builder makes of the label:

- every section split into candidate sentences, with lead-ins;
- the catalog request at several token budgets: prompt hash, skipped questions, candidate IDs
  per question, evidence chunks, and each part's hash and token estimate;
- a reader's custom question, the same way.

The fixture file also holds the full request parts and a shortlist request, so a mismatch in
the port shows exactly which field differs.
"""

import hashlib
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from rx_jev_api.clients.openfda import Label, OpenFdaClient
from rx_jev_api.db import make_engine
from rx_jev_api.judge import (
    MAX_CHOICE_OPTIONS,
    Distribution,
    JudgePart,
    JudgeRequest,
    build_custom_request,
    build_request,
    estimate_tokens,
    shortlist_part,
)
from rx_jev_api.sentences import split_section
from rx_jev_api.store import LabelRecord
from tests.recorded import FIXTURES, openfda_http

OUT = FIXTURES / "golden"
# The production budget, one that splits long labels, and one that skips questions.
BUDGETS = (55_000, 12_000, 3_000)
CUSTOM_QUESTION = "Can I drink grapefruit juice while taking this?"
FIXTURE_DRUGS = [["ibuprofen"], ["metformin"], ["acetaminophen", "diphenhydramine"], ["loratadine"]]


def part_body(part: JudgePart) -> dict[str, Any]:
    return {
        "state": part.state,
        "questions": {k: q.model_dump(mode="json") for k, q in part.questions.items()},
    }


def part_hash(part: JudgePart) -> str:
    encoded = json.dumps(
        part_body(part), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(encoded.encode()).hexdigest()


def request_golden(request: JudgeRequest, full: bool) -> dict[str, Any]:
    golden: dict[str, Any] = {
        "prompt_hash": request.prompt_hash,
        "skipped": request.skipped,
        "asked": {q: [c.id for c in cs] for q, cs in request.asked.items()},
        "evidence_chunks": {q: spec.chunks for q, spec in request.evidence_chunks.items()},
        "parts": [
            {"hash": part_hash(p), "estimate": estimate_tokens(p.state, p.questions)}
            for p in request.parts
        ],
    }
    if full:
        golden["bodies"] = [part_body(p) for p in request.parts]
    return golden


def label_golden(label: Label, full: bool) -> dict[str, Any]:
    return {
        "label": label.model_dump(mode="json"),
        "candidates": {
            name: [
                {"id": c.id, "text": c.text, "lead_in": c.lead_in.text if c.lead_in else None}
                for c in split_section(name, text)
            ]
            for name, text in label.sections.items()
        },
        "requests": {
            str(budget): request_golden(build_request(label, max_tokens=budget), full)
            for budget in BUDGETS
        },
        "custom": request_golden(build_custom_request(label, CUSTOM_QUESTION), full),
    }


def first_option_answers(request: JudgeRequest) -> dict[str, Distribution]:
    """Deterministic first-round answers: each question peaks on its last-but-one option."""
    answers: dict[str, Distribution] = {}
    for part in request.parts:
        for key, question in part.questions.items():
            options = list(question.criteria)
            favourite = options[-2] if len(options) > 1 else options[0]
            rest = [o for o in options if o != favourite]
            probabilities = {o: 0.1 / len(rest) for o in rest} | {favourite: 0.9}
            answers[key] = Distribution(
                choice=favourite, confidence=0.8, probabilities=probabilities
            )
    return answers


def long_label() -> Label:
    """More evidence candidates than one Choice holds, so the shortlist request is used."""
    text = " ".join(f"Sentence number {n} is here." for n in range(MAX_CHOICE_OPTIONS))
    return Label(
        set_id="long",
        version="1",
        effective_time=date(2026, 1, 1),
        product_type="prescription",
        brand_name=None,
        manufacturer_name=None,
        substance_names=["X"],
        is_original_packager=True,
        sections={"pregnancy": "Pregnancy is discussed here.", "contraindications": text},
    )


def fixture_labels() -> list[Label]:
    client = OpenFdaClient(openfda_http())
    labels: list[Label] = []
    for drug in FIXTURE_DRUGS:
        canonical = client.canonical_labels(drug)
        labels += [lb for lb in (canonical.otc, canonical.prescription) if lb is not None]
    return labels


def write_fixtures() -> None:
    long = long_label()
    request = build_request(long)
    shortlist = shortlist_part(request, first_option_answers(request))
    golden = {
        "custom_question": CUSTOM_QUESTION,
        "labels": [label_golden(label, full=True) for label in [*fixture_labels(), long]],
        "shortlist": {
            "set_id": long.set_id,
            "answers": {k: d.model_dump() for k, d in first_option_answers(request).items()},
            "hash": part_hash(shortlist),
            "body": part_body(shortlist),
        },
    }
    path = OUT / "fixtures.json"
    path.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + "\n")
    print(f"Wrote {len(golden['labels'])} labels to {path}")


def write_store(database: Path) -> None:
    if not database.exists():
        print(f"No store at {database}; skipped store golden file.")
        return
    path = OUT / "store.jsonl"
    count = 0
    with Session(make_engine(f"sqlite:///{database}")) as session, path.open("w") as out:
        records = session.exec(select(LabelRecord).order_by(LabelRecord.set_id)).all()
        for record in records:
            label = Label.model_validate(record.raw)
            out.write(json.dumps(label_golden(label, full=False), ensure_ascii=False) + "\n")
            count += 1
    print(f"Wrote {count} labels to {path}")


def main() -> None:
    database = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("rx_jev.db")
    OUT.mkdir(parents=True, exist_ok=True)
    write_fixtures()
    write_store(database)


if __name__ == "__main__":
    main()
