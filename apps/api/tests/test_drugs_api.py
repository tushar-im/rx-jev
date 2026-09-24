from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from rx_jev_api.clients.errors import UpstreamError
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.deps import get_drug_names, get_rxnorm_client
from rx_jev_api.main import app
from rx_jev_api.problems import PROBLEM_JSON
from tests.recorded import rxnorm_http

NAMES = ["advil", "advil pm", "glipiZIDE / metFORMIN", "metFORMIN", "tylenol pm"]


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_rxnorm_client] = lambda: RxNormClient(rxnorm_http())
    app.dependency_overrides[get_drug_names] = lambda: NAMES
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def test_suggestions_match_the_start_of_a_name_or_word(client: TestClient) -> None:
    response = client.get("/api/drugs/suggestions", params={"q": "metf"})

    assert response.status_code == 200
    assert response.json() == {
        "query": "metf",
        "names": ["metFORMIN", "glipiZIDE / metFORMIN"],
    }


@pytest.mark.parametrize("q", ["a", "x" * 101])
def test_suggestions_reject_a_query_too_short_or_too_long(client: TestClient, q: str) -> None:
    response = client.get("/api/drugs/suggestions", params={"q": q})

    assert response.status_code == 422
    assert response.headers["content-type"] == PROBLEM_JSON


def test_suggestions_fail_as_a_problem_when_rxnorm_is_down(client: TestClient) -> None:
    def down() -> list[str]:
        raise UpstreamError("RxNorm request failed: /displaynames.json")

    app.dependency_overrides[get_drug_names] = down
    response = client.get("/api/drugs/suggestions", params={"q": "adv"})

    assert response.status_code == 502
    assert response.headers["content-type"] == PROBLEM_JSON


def test_resolve_turns_a_brand_into_its_ingredient_set(client: TestClient) -> None:
    response = client.get("/api/drugs/resolve", params={"name": "Advil"})

    assert response.status_code == 200
    assert response.json() == {
        "query": "Advil",
        "rxcui": "5640",
        "ingredients": [{"rxcui": "5640", "name": "ibuprofen"}],
    }


def test_resolve_keeps_combinations_together(client: TestClient) -> None:
    body = client.get("/api/drugs/resolve", params={"name": "Tylenol PM"}).json()

    assert body["rxcui"] == "214181"
    assert [i["name"] for i in body["ingredients"]] == ["acetaminophen", "diphenhydramine"]


def test_resolve_unknown_name_is_a_404_problem(client: TestClient) -> None:
    response = client.get("/api/drugs/resolve", params={"name": "xyzzynotadrug"})

    assert response.status_code == 404
    assert response.headers["content-type"] == PROBLEM_JSON
    assert "xyzzynotadrug" in response.json()["detail"]


def test_display_names_are_read_from_rxnorm() -> None:
    names = RxNormClient(rxnorm_http()).display_names()

    assert "advil" in names
    assert "metFORMIN" in names


def test_malformed_display_names_are_an_upstream_error() -> None:
    def bad(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"displayTermsList": {"term": "advil"}})

    http = httpx.Client(transport=httpx.MockTransport(bad), base_url="https://x.test")
    with pytest.raises(UpstreamError):
        RxNormClient(http).display_names()
