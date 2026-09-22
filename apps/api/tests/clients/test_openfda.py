import hashlib
import json
from datetime import date
from pathlib import Path

import httpx
import pytest

from rx_jev_api.clients.openfda import (
    PAGE_SIZE,
    OpenFdaClient,
    UpstreamError,
    matches_ingredients,
)

FIXTURES = Path(__file__).parent.parent / "fixtures" / "openfda"


def recorded(request: httpx.Request) -> httpx.Response:
    """Serve pages saved by scripts/record_openfda.py; fail on any unrecorded request."""
    params = request.url.params
    key = f"{params['search']}|{params['skip']}|{params['limit']}"
    fixture = FIXTURES / (hashlib.sha1(key.encode()).hexdigest()[:12] + ".json")
    if not fixture.exists():
        raise AssertionError(f"Unrecorded request: {params}")
    envelope = json.loads(fixture.read_text())
    return httpx.Response(envelope["status"], json=envelope["body"])


def make_client(handler: httpx.MockTransport, api_key: str | None = None) -> OpenFdaClient:
    return OpenFdaClient(httpx.Client(transport=handler, base_url="https://fda.test"), api_key)


@pytest.fixture
def client() -> OpenFdaClient:
    return make_client(httpx.MockTransport(recorded))


def fake_label(set_id: str, substances: list[str], original: bool = True) -> dict:
    return {
        "set_id": set_id,
        "version": "1",
        "effective_time": "20260101",
        "openfda": {
            "product_type": ["HUMAN OTC DRUG"],
            "substance_name": substances,
            "brand_name": ["Brand"],
            "manufacturer_name": ["Maker"],
            "is_original_packager": [original],
        },
        "warnings": ["Line one.", "Line two."],
    }


def test_drug_with_both_types_returns_one_label_per_type(client: OpenFdaClient) -> None:
    labels = client.canonical_labels(["ibuprofen"])

    assert labels.otc is not None
    assert labels.otc.set_id == "0ca02f8b-4413-4e7c-a67b-8c67c53e1343"
    assert labels.otc.product_type == "otc"
    assert labels.otc.effective_time == date(2026, 9, 9)
    assert labels.otc.is_original_packager is True
    assert labels.prescription is not None
    assert labels.prescription.set_id == "3e131710-2579-446e-8076-f602ecea813f"
    assert labels.prescription.product_type == "prescription"


def test_label_carries_sections_version_and_dailymed_link(client: OpenFdaClient) -> None:
    label = client.canonical_labels(["ibuprofen"]).otc

    assert label is not None
    assert label.version == "5"
    assert "do_not_use" in label.sections
    assert label.sections["do_not_use"].strip() != ""
    assert not any(name.endswith("_table") for name in label.sections)
    assert label.dailymed_url == (
        "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid="
        "0ca02f8b-4413-4e7c-a67b-8c67c53e1343"
    )


def test_combination_skips_labels_with_extra_ingredients(client: OpenFdaClient) -> None:
    labels = client.canonical_labels(["acetaminophen", "diphenhydramine"])

    assert labels.otc is not None
    assert labels.otc.set_id == "923b443d-73cc-4c52-92e4-a075786b1ae3"
    assert labels.prescription is None


def test_salt_forms_match_and_missing_type_is_none(client: OpenFdaClient) -> None:
    labels = client.canonical_labels(["metformin"])

    assert labels.otc is None
    assert labels.prescription is not None
    assert labels.prescription.set_id == "7cc02a26-5c22-445b-ad8f-3e7570c143d3"
    assert labels.prescription.substance_names == ["METFORMIN HYDROCHLORIDE"]


def test_falls_back_to_repackagers_when_no_original_packager(client: OpenFdaClient) -> None:
    labels = client.canonical_labels(["loratadine"])

    assert labels.prescription is not None
    assert labels.prescription.set_id == "0d74af21-3ef7-418b-a2ef-78737b0af288"
    assert labels.prescription.is_original_packager is False


def test_pages_until_an_exact_match_is_found() -> None:
    skips: list[str] = []

    def paged(request: httpx.Request) -> httpx.Response:
        skip = request.url.params["skip"]
        skips.append(skip)
        if request.url.params["search"].count("HUMAN OTC DRUG") == 0:
            return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})
        if skip == "0":
            combos = [fake_label(f"combo-{n}", ["IBUPROFEN", "FAMOTIDINE"]) for n in range(5)]
            return httpx.Response(200, json={"results": combos})
        return httpx.Response(200, json={"results": [fake_label("single", ["IBUPROFEN"])]})

    labels = make_client(httpx.MockTransport(paged)).canonical_labels(["ibuprofen"])

    assert labels.otc is not None
    assert labels.otc.set_id == "single"
    assert "0" in skips and str(PAGE_SIZE) in skips


def test_sections_join_list_items_verbatim() -> None:
    def one(request: httpx.Request) -> httpx.Response:
        if "HUMAN OTC DRUG" not in request.url.params["search"]:
            return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})
        return httpx.Response(200, json={"results": [fake_label("s", ["IBUPROFEN"])]})

    labels = make_client(httpx.MockTransport(one)).canonical_labels(["ibuprofen"])

    assert labels.otc is not None
    assert labels.otc.sections == {"warnings": "Line one.\n\nLine two."}


def test_api_key_is_sent_when_configured() -> None:
    keys: list[str | None] = []

    def capture(request: httpx.Request) -> httpx.Response:
        keys.append(request.url.params.get("api_key"))
        return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})

    make_client(httpx.MockTransport(capture), api_key="k123").canonical_labels(["ibuprofen"])

    assert keys and all(k == "k123" for k in keys)


def test_upstream_server_error_raises_upstream_error() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    with pytest.raises(UpstreamError):
        make_client(httpx.MockTransport(down)).canonical_labels(["ibuprofen"])


def test_malformed_payload_raises_upstream_error() -> None:
    def garbage(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [{"set_id": 5}]})

    with pytest.raises(UpstreamError):
        make_client(httpx.MockTransport(garbage)).canonical_labels(["ibuprofen"])


def test_no_ingredients_is_rejected() -> None:
    with pytest.raises(ValueError):
        make_client(httpx.MockTransport(recorded)).canonical_labels([])


@pytest.mark.parametrize(
    ("substances", "ingredients", "expected"),
    [
        (["IBUPROFEN"], ["ibuprofen"], True),
        (["IBUPROFEN SODIUM"], ["ibuprofen"], True),
        (["IBUPROFEN", "FAMOTIDINE"], ["ibuprofen"], False),
        (["IBUPROFENOL"], ["ibuprofen"], False),
        (["ACETAMINOPHEN", "DIPHENHYDRAMINE CITRATE"], ["diphenhydramine", "acetaminophen"], True),
        (["ACETAMINOPHEN", "ACETAMINOPHEN"], ["acetaminophen", "diphenhydramine"], False),
        ([], ["ibuprofen"], False),
    ],
)
def test_matches_ingredients(substances: list[str], ingredients: list[str], expected: bool) -> None:
    assert matches_ingredients(substances, ingredients) is expected
