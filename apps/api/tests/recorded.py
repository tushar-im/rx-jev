"""Transports that replay recorded upstream responses. Any unrecorded request fails."""

import hashlib
import json
from pathlib import Path

import httpx

FIXTURES = Path(__file__).parent / "fixtures"


def _rxnorm(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path.endswith("/rxcui.json"):
        name = request.url.params["name"].lower().replace(" ", "_")
        fixture = FIXTURES / "rxnorm" / f"rxcui_{name}.json"
    elif path.endswith("/related.json"):
        fixture = FIXTURES / "rxnorm" / f"related_{path.split('/')[-2]}.json"
    else:
        raise AssertionError(f"Unexpected request: {request.url}")
    return httpx.Response(200, json=json.loads(fixture.read_text()))


def _openfda(request: httpx.Request) -> httpx.Response:
    # Names match scripts/record_openfda.py.
    params = request.url.params
    key = f"{params['search']}|{params['skip']}|{params['limit']}"
    fixture = FIXTURES / "openfda" / (hashlib.sha1(key.encode()).hexdigest()[:12] + ".json")
    if not fixture.exists():
        raise AssertionError(f"Unrecorded request: {params}")
    envelope = json.loads(fixture.read_text())
    return httpx.Response(envelope["status"], json=envelope["body"])


def rxnorm_http() -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(_rxnorm), base_url="https://rxnav.test")


def openfda_http() -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(_openfda), base_url="https://fda.test")
