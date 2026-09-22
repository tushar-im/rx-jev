import httpx
import pytest

from rx_jev_api.clients.rxnorm import Ingredient, RxNormClient, UpstreamError
from tests.recorded import rxnorm_http


@pytest.fixture
def client() -> RxNormClient:
    return RxNormClient(rxnorm_http())


def test_brand_name_resolves_to_its_ingredient(client: RxNormClient) -> None:
    result = client.resolve("Advil")

    assert result is not None
    assert result.query == "Advil"
    assert result.matched_rxcui == "153010"
    assert result.ingredients == [Ingredient(rxcui="5640", name="ibuprofen")]
    assert result.rxcui == "5640"


def test_misspelled_name_still_resolves(client: RxNormClient) -> None:
    result = client.resolve("advill")

    assert result is not None
    assert result.rxcui == "5640"


def test_ingredient_name_resolves_to_itself(client: RxNormClient) -> None:
    result = client.resolve("metformin")

    assert result is not None
    assert result.matched_rxcui == "6809"
    assert result.ingredients == [Ingredient(rxcui="6809", name="metformin")]
    assert result.rxcui == "6809"


def test_combination_product_uses_the_multi_ingredient_concept(client: RxNormClient) -> None:
    result = client.resolve("Tylenol PM")

    assert result is not None
    assert result.ingredients == [
        Ingredient(rxcui="161", name="acetaminophen"),
        Ingredient(rxcui="3498", name="diphenhydramine"),
    ]
    assert result.rxcui == "214181"


def test_unknown_name_returns_none(client: RxNormClient) -> None:
    assert client.resolve("xyzzynotadrug") is None


def test_blank_name_returns_none_without_calling_rxnorm() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise AssertionError("RxNorm must not be called for a blank name")

    client = RxNormClient(httpx.Client(transport=httpx.MockTransport(fail), base_url="https://x"))

    assert client.resolve("   ") is None


def test_upstream_http_error_raises_upstream_error() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    client = RxNormClient(httpx.Client(transport=httpx.MockTransport(down), base_url="https://x"))

    with pytest.raises(UpstreamError):
        client.resolve("Advil")


def test_malformed_upstream_payload_raises_upstream_error() -> None:
    def garbage(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"idGroup": {"rxnormId": "not-a-list"}})

    client = RxNormClient(
        httpx.Client(transport=httpx.MockTransport(garbage), base_url="https://x")
    )

    with pytest.raises(UpstreamError):
        client.resolve("Advil")


def test_network_failure_raises_upstream_error() -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    client = RxNormClient(
        httpx.Client(transport=httpx.MockTransport(unreachable), base_url="https://x")
    )

    with pytest.raises(UpstreamError):
        client.resolve("Advil")
