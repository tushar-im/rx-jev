from datetime import date

import httpx
import pytest

from rx_jev_api.clients.openfda import (
    PAGE_SIZE,
    OpenFdaClient,
    UpstreamError,
    matches_ingredients,
)
from tests.recorded import openfda_http


def make_client(handler: httpx.MockTransport, api_key: str | None = None) -> OpenFdaClient:
    return OpenFdaClient(httpx.Client(transport=handler, base_url="https://fda.test"), api_key)


@pytest.fixture
def client() -> OpenFdaClient:
    return OpenFdaClient(openfda_http())


def fake_label(
    set_id: str,
    substances: list[str],
    original: bool = True,
    application_number: list[str] | None = None,
) -> dict:
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
            "application_number": ["M013"] if application_number is None else application_number,
        },
        "warnings": ["Line one.", "Line two."],
    }


def otc_only(results: list[dict]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if "HUMAN OTC DRUG" not in request.url.params["search"]:
            return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})
        skip, limit = int(request.url.params["skip"]), int(request.url.params["limit"])
        return httpx.Response(200, json={"results": results[skip : skip + limit]})

    return httpx.MockTransport(handler)


def test_skips_labels_without_an_application_number() -> None:
    # Homeopathic products carry no NDA, ANDA, BLA or monograph number, and are not the drug.
    results = [
        fake_label("homeopathic", ["CITALOPRAM"], application_number=[]),
        fake_label("approved", ["CITALOPRAM HYDROBROMIDE"], application_number=["ANDA077031"]),
    ]
    labels = make_client(otc_only(results)).canonical_labels(["citalopram"])

    assert labels.otc is not None
    assert labels.otc.set_id == "approved"


def test_only_labels_without_an_application_number_is_none() -> None:
    results = [fake_label("homeopathic", ["LEVOTHYROXINE"], application_number=[])]
    labels = make_client(otc_only(results)).canonical_labels(["levothyroxine"])

    assert labels.otc is None


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
        OpenFdaClient(openfda_http()).canonical_labels([])


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


def test_keeps_paging_with_growing_pages_until_results_run_out() -> None:
    combos = [fake_label(f"combo-{n}", ["IBUPROFEN", "FAMOTIDINE"]) for n in range(60)]
    results = [*combos, fake_label("late-single", ["IBUPROFEN"])]
    limits: list[str] = []

    def paged(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        if (
            "HUMAN OTC DRUG" not in params["search"]
            or "is_original_packager" not in params["search"]
        ):
            return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})
        limits.append(params["limit"])
        skip, limit = int(params["skip"]), int(params["limit"])
        return httpx.Response(200, json={"results": results[skip : skip + limit]})

    labels = make_client(httpx.MockTransport(paged)).canonical_labels(["ibuprofen"])

    assert labels.otc is not None
    assert labels.otc.set_id == "late-single"
    assert labels.otc.is_original_packager is True
    assert limits == ["5", "25", "100"]


def test_no_exact_match_after_exhausting_results_falls_back_then_returns_none() -> None:
    combos = [fake_label(f"combo-{n}", ["IBUPROFEN", "FAMOTIDINE"]) for n in range(40)]

    def paged(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        if "HUMAN OTC DRUG" not in params["search"]:
            return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})
        skip, limit = int(params["skip"]), int(params["limit"])
        return httpx.Response(200, json={"results": combos[skip : skip + limit]})

    assert make_client(httpx.MockTransport(paged)).canonical_labels(["ibuprofen"]).otc is None
