"""Record openFDA label search pages as test fixtures.

Run: uv run python scripts/record_openfda.py

Replays the canonical-label search strategy for a handful of drugs and saves every page
it touches. To keep fixtures small, label sections are dropped from every result except
the first exact ingredient match in each search, which is the label the tests expect.
"""

import hashlib
import json
from pathlib import Path

import httpx

BASE = "https://api.fda.gov"
OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "openfda"
PAGE_SIZE = 5
MAX_PAGES = 4
PRODUCT_TYPES = ["HUMAN OTC DRUG", "HUMAN PRESCRIPTION DRUG"]
CASES = [["ibuprofen"], ["metformin"], ["acetaminophen", "diphenhydramine"], ["loratadine"]]
METADATA = {"id", "set_id", "version", "effective_time", "openfda"}


def fixture_name(search: str, skip: int) -> str:
    return hashlib.sha1(f"{search}|{skip}|{PAGE_SIZE}".encode()).hexdigest()[:12] + ".json"


def is_exact(label: dict, ingredients: list[str]) -> bool:
    subs = [s.upper() for s in label.get("openfda", {}).get("substance_name", [])]
    wanted = [i.upper() for i in ingredients]
    return len(subs) == len(wanted) and all(
        any(s == w or s.startswith(w + " ") for s in subs) for w in wanted
    )


def record(client: httpx.Client, search: str, ingredients: list[str]) -> bool:
    for page in range(MAX_PAGES):
        skip = page * PAGE_SIZE
        params = {"search": search, "limit": PAGE_SIZE, "skip": skip, "sort": "effective_time:desc"}
        response = client.get("/drug/label.json", params=params)
        body = response.json()
        found = False
        for label in body.get("results", []):
            if not found and is_exact(label, ingredients):
                found = True
                continue
            for key in list(label):
                if key not in METADATA:
                    del label[key]
        envelope = {"status": response.status_code, "body": body}
        (OUT / fixture_name(search, skip)).write_text(json.dumps(envelope, indent=1) + "\n")
        print(f"{response.status_code} skip={skip} found={found} {search}")
        if found or response.status_code != 200 or len(body.get("results", [])) < PAGE_SIZE:
            return found
    return False


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(base_url=BASE, timeout=60) as client:
        for ingredients in CASES:
            for product_type in PRODUCT_TYPES:
                base = " AND ".join(f'openfda.substance_name:"{i}"' for i in ingredients)
                base += f' AND openfda.product_type:"{product_type}"'
                if not record(client, base + " AND openfda.is_original_packager:true", ingredients):
                    record(client, base, ingredients)


if __name__ == "__main__":
    main()
