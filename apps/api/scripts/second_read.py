"""Blind second read of the Gate 1 review sheet (G1.3).

Run from apps/api after build_review_sheet.py:

    uv run python scripts/second_read.py packets    # writes second_read/packets/*.json
    uv run python scripts/second_read.py compare    # reads second_read/grades/*.json

Packets hold each row's question and candidate sentences, never Jev's answer, batched by
label so shared text is read once. Each grade batch is a JSON list of
{"row_id", "stance", "evidence", "note"}. `compare` writes review_sheet_compared.csv with
both readings and lists the rows the owner must decide.
"""

import csv
import json
import sys
from collections import Counter
from pathlib import Path

from sqlmodel import Session

from rx_jev_api.config import get_settings
from rx_jev_api.db import make_engine
from rx_jev_api.review import REVIEW_COLUMNS, ReviewRow
from rx_jev_api.second_read import (
    compare,
    load_candidate_ids,
    packet,
    read_grades,
    write_packet_batches,
)
from rx_jev_api.store import Store

SHEET = Path("review_sheet.json")
ROOT = Path("second_read")
# Characters of sentence text per packet batch, so one reader can hold a batch at once.
BATCH_CHARS = 120_000


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    rows = [ReviewRow.model_validate(r) for r in json.loads(SHEET.read_text())]
    if command == "packets":
        write_packets(rows)
    elif command == "compare":
        write_comparison(rows)
    else:
        sys.exit("Usage: second_read.py packets | compare")


def write_packets(rows: list[ReviewRow]) -> None:
    out = ROOT / "packets"
    with Session(make_engine(get_settings().database_url)) as session:
        store = Store(session)
        items = []
        for row in sorted(rows, key=lambda r: (r.set_id, r.row_id)):
            label = store.label(row.set_id, row.version)
            if label is None:
                sys.exit(f"Label {row.set_id} v{row.version} is not in the store.")
            items.append(packet(row, label))

    count = write_packet_batches(out, items, BATCH_CHARS)
    print(f"{len(items)} rows in {count} packet batches under {out}/")


def write_comparison(rows: list[ReviewRow]) -> None:
    try:
        candidate_ids = load_candidate_ids(ROOT / "packets", [r.row_id for r in rows])
        results = compare(rows, read_grades(ROOT / "grades"), candidate_ids)
    except ValueError as exc:
        sys.exit(f"Cannot compare: {exc}")
    path = Path("review_sheet_compared.csv")
    fields = [
        *ReviewRow.model_fields,
        "claude_stance",
        "claude_evidence",
        "claude_note",
        "stance_agrees",
        "evidence_match",
        "needs_human",
        *REVIEW_COLUMNS,
    ]
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in results:
            record: dict[str, object] = r.row.model_dump()
            record["sections"] = ", ".join(r.row.sections)
            record["reasons"] = ", ".join(r.row.reasons)
            writer.writerow(
                record
                | {
                    "claude_stance": r.grade.stance if r.grade else "",
                    "claude_evidence": r.grade.evidence if r.grade else "",
                    "claude_note": r.grade.note if r.grade else "",
                    "stance_agrees": r.stance_agrees,
                    "evidence_match": r.evidence or "",
                    "needs_human": r.needs_human,
                }
                | dict.fromkeys(REVIEW_COLUMNS, "")
            )

    graded = [r for r in results if r.graded]
    print(f"{len(graded)}/{len(results)} rows graded.")
    print(f"Stance agrees: {sum(r.stance_agrees for r in graded)}/{len(graded)}")
    print("Evidence:", dict(Counter(r.evidence for r in graded)))
    print(f"Rows needing a human: {sum(r.needs_human for r in results)}. Wrote {path}")


if __name__ == "__main__":
    main()
