"""Record openFDA label search pages as test fixtures.

Run: uv run python scripts/record_openfda.py [output_dir]

Drives the real OpenFdaClient through a recording transport, so the recorded requests are
exactly the ones the client makes. An upstream failure (429, 5xx) raises UpstreamError and
aborts the run instead of being recorded as "no match". To keep fixtures small, label
sections are dropped from every result except the selected canonical labels.
"""

import hashlib
import json
import sys
from pathlib import Path

import httpx

from rx_jev_api.clients.openfda import OpenFdaClient

BASE = "https://api.fda.gov"
DEFAULT_OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "openfda"
CASES = [["ibuprofen"], ["metformin"], ["acetaminophen", "diphenhydramine"], ["loratadine"]]
METADATA = {"id", "set_id", "version", "effective_time", "openfda"}


def fixture_name(request: httpx.Request) -> str:
    # Must match tests/recorded.py.
    params = request.url.params
    key = f"{params['search']}|{params['skip']}|{params['limit']}"
    return hashlib.sha1(key.encode()).hexdigest()[:12] + ".json"


class RecordingTransport(httpx.BaseTransport):
    def __init__(self) -> None:
        self._inner = httpx.HTTPTransport()
        self.pages: dict[str, dict] = {}

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        response = self._inner.handle_request(request)
        response.read()
        if response.status_code in (200, 404):
            self.pages[fixture_name(request)] = {
                "status": response.status_code,
                "body": response.json(),
            }
        return response


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    transport = RecordingTransport()
    winners: set[str] = set()
    with httpx.Client(transport=transport, base_url=BASE, timeout=60) as http:
        client = OpenFdaClient(http)
        for ingredients in CASES:
            labels = client.canonical_labels(ingredients)
            for label in (labels.otc, labels.prescription):
                if label is not None:
                    winners.add(label.set_id)
                    print(f"{' + '.join(ingredients)}: {label.product_type} {label.set_id}")

    out.mkdir(parents=True, exist_ok=True)
    for name, envelope in transport.pages.items():
        for result in envelope["body"].get("results", []):
            if result.get("set_id") not in winners:
                for key in [k for k in result if k not in METADATA]:
                    del result[key]
        (out / name).write_text(json.dumps(envelope, indent=1) + "\n")
    print(f"Wrote {len(transport.pages)} pages to {out}")


if __name__ == "__main__":
    main()
