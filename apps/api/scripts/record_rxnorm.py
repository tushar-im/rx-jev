"""Record RxNorm responses as test fixtures. Run: uv run python scripts/record_rxnorm.py"""

import json
from pathlib import Path

import httpx

BASE = "https://rxnav.nlm.nih.gov/REST"
OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "rxnorm"
NAMES = ["Advil", "advill", "metformin", "Tylenol PM", "xyzzynotadrug"]
# Ingredient-set RxCUIs looked up directly; 0 is not a real concept.
RXCUIS = ["5640", "214181", "0"]
# The display name list is about 28K names; keep only names sharing a word with these.
DISPLAY_WORDS = ("advil", "metformin", "tylenol")


def slug(text: str) -> str:
    return text.lower().replace(" ", "_")


def save(name: str, payload: object) -> None:
    (OUT / f"{name}.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(base_url=BASE, timeout=20) as client:
        for name in NAMES:
            lookup = client.get("/rxcui.json", params={"name": name, "search": 2}).json()
            save(f"rxcui_{slug(name)}", lookup)
            for rxcui in lookup["idGroup"].get("rxnormId", []):
                related = client.get(f"/rxcui/{rxcui}/related.json", params={"tty": "IN MIN"})
                save(f"related_{rxcui}", related.json())
        for rxcui in RXCUIS:
            related = client.get(f"/rxcui/{rxcui}/related.json", params={"tty": "IN MIN"})
            save(f"related_{rxcui}", related.json())
        record_display_names(client)


def record_display_names(client: httpx.Client) -> None:
    payload = client.get("/displaynames.json").json()
    terms = payload["displayTermsList"]["term"]
    kept = [t for t in terms if any(w in t.lower() for w in DISPLAY_WORDS)]
    save("displaynames", {"displayTermsList": {"term": kept}})


if __name__ == "__main__":
    main()
