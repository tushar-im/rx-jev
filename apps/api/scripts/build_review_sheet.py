"""Build the Gate 1 review sheet from the review-set report and the stored judgments (G1.2).

Run from apps/api after precompute_review_set.py:

    uv run python scripts/build_review_sheet.py [report.json] [per_band] [seed]

Writes review_sheet.csv and review_sheet.json. Never calls Jev: labels without a stored run
are listed and left out. Mark rows as described in docs/gate-1-review-rules.md.
"""

import json
import sys
from collections import Counter
from pathlib import Path

from sqlmodel import Session

from rx_jev_api.answering import JudgedLabel
from rx_jev_api.config import get_settings
from rx_jev_api.db import make_engine
from rx_jev_api.judge import build_request
from rx_jev_api.review import ReviewRow, label_rows, select_rows, write_csv, write_json
from rx_jev_api.store import Store

REPORT = Path("review_set_report.json")
PER_BAND = 60
SEED = 1


def main() -> None:
    report_path = Path(sys.argv[1]) if len(sys.argv) > 1 else REPORT
    per_band = int(sys.argv[2]) if len(sys.argv) > 2 else PER_BAND
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else SEED
    settings = get_settings()

    rows: list[ReviewRow] = []
    missing: list[str] = []
    with Session(make_engine(settings.database_url)) as session:
        store = Store(session)
        for drug in json.loads(report_path.read_text()):
            for entry in drug["labels"]:
                label = store.label(entry["set_id"], entry["version"])
                if label is None:
                    if entry["model_version"] is not None:
                        missing.append(f"{drug['name']} ({entry['product_type']})")
                    continue
                request = build_request(label)
                run = store.find(label, request.prompt_hash, settings.typesafe_model)
                if run is None:
                    missing.append(f"{drug['name']} ({entry['product_type']})")
                    continue
                judged = JudgedLabel(label=label, request=request, run=run, fresh=False)
                rows.extend(label_rows(drug["name"], judged))

    selected = select_rows(rows, per_band=per_band, seed=seed)
    write_csv(Path("review_sheet.csv"), selected)
    write_json(Path("review_sheet.json"), selected)

    reasons = Counter(reason for row in selected for reason in row.reasons)
    print(f"{len(rows)} judged answers, {len(selected)} selected for review.")
    for reason, count in reasons.most_common():
        print(f"  {reason:26} {count}")
    if missing:
        print("No stored run, left out: " + ", ".join(missing))
    print("Wrote review_sheet.csv and review_sheet.json")


if __name__ == "__main__":
    main()
