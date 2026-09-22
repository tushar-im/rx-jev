from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from rx_jev_api.catalog import CATALOG
from rx_jev_api.clients.openfda import OpenFdaClient
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.deps import get_openfda_client, get_rxnorm_client
from rx_jev_api.main import app
from rx_jev_api.problems import PROBLEM_JSON
from tests.recorded import openfda_http, rxnorm_http


def not_found(request: httpx.Request) -> httpx.Response:
    return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})


def unavailable(request: httpx.Request) -> httpx.Response:
    return httpx.Response(503, text="upstream secret stack trace")


def mock(handler: httpx.MockTransport) -> httpx.Client:
    return httpx.Client(transport=handler, base_url="https://x.test")


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_rxnorm_client] = lambda: RxNormClient(rxnorm_http())
    app.dependency_overrides[get_openfda_client] = lambda: OpenFdaClient(openfda_http())
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def test_returns_one_label_per_available_type(client: TestClient) -> None:
    response = client.get("/api/labels/5640")

    assert response.status_code == 200
    body = response.json()
    assert body["rxcui"] == "5640"
    assert body["ingredients"] == [{"rxcui": "5640", "name": "ibuprofen"}]
    assert [label["product_type"] for label in body["labels"]] == ["otc", "prescription"]


def test_label_carries_provenance(client: TestClient) -> None:
    otc = client.get("/api/labels/5640").json()["labels"][0]

    assert otc["set_id"] == "0ca02f8b-4413-4e7c-a67b-8c67c53e1343"
    assert otc["version"] == "5"
    assert otc["effective_time"] == "2026-09-09"
    assert otc["dailymed_url"].endswith("setid=0ca02f8b-4413-4e7c-a67b-8c67c53e1343")
    assert otc["layout"] == "otc"


def test_every_catalog_question_lists_its_candidate_sections(client: TestClient) -> None:
    otc = client.get("/api/labels/5640").json()["labels"][0]
    questions = {q["id"]: q for q in otc["questions"]}

    assert list(questions) == [q.id for q in CATALOG]
    assert questions["pregnancy"]["title"] == "Pregnancy"
    assert questions["pregnancy"]["group"] == "who"
    assert questions["pregnancy"]["sections"] == ["pregnancy_or_breast_feeding"]
    assert questions["boxed_warning"]["sections"] == []


def test_sections_hold_verbatim_candidates_for_referenced_sections_only(
    client: TestClient,
) -> None:
    otc = client.get("/api/labels/5640").json()["labels"][0]
    referenced = {name for q in otc["questions"] for name in q["sections"]}

    assert set(otc["sections"]) == referenced
    candidate = otc["sections"]["pregnancy_or_breast_feeding"][0]
    assert candidate["id"] == "pregnancy_or_breast_feeding:1"
    assert candidate["text"].startswith("If pregnant or breast-feeding")
    assert set(candidate) == {"id", "text", "lead_in"}


def test_combination_rxcui_resolves_its_ingredients(client: TestClient) -> None:
    body = client.get("/api/labels/214181").json()

    assert [i["name"] for i in body["ingredients"]] == ["acetaminophen", "diphenhydramine"]
    assert [label["product_type"] for label in body["labels"]] == ["otc"]


def test_non_numeric_rxcui_is_422_problem(client: TestClient) -> None:
    response = client.get("/api/labels/advil")

    assert response.status_code == 422
    assert response.headers["content-type"].startswith(PROBLEM_JSON)


def test_unknown_rxcui_is_404_problem(client: TestClient) -> None:
    response = client.get("/api/labels/0")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["detail"] == "No drug found for RxCUI 0."


def test_drug_without_any_fda_label_is_404_problem(client: TestClient) -> None:
    app.dependency_overrides[get_openfda_client] = lambda: OpenFdaClient(
        mock(httpx.MockTransport(not_found))
    )

    response = client.get("/api/labels/5640")

    assert response.status_code == 404
    assert response.json()["detail"] == "No FDA label found for ibuprofen."


def test_upstream_failure_is_502_problem_without_leaking(client: TestClient) -> None:
    app.dependency_overrides[get_rxnorm_client] = lambda: RxNormClient(
        mock(httpx.MockTransport(unavailable))
    )

    response = client.get("/api/labels/5640")

    assert response.status_code == 502
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["detail"] == "A drug data source is unavailable. Try again later."
    assert "secret" not in response.text


def test_bullet_candidates_expose_their_lead_in(client: TestClient) -> None:
    label = client.get("/api/labels/6809").json()["labels"][0]
    candidates = label["sections"]["contraindications"]

    item = next(c for c in candidates if c["text"] == "Hypersensitivity to metformin.")
    assert item["lead_in"] is not None
    assert item["lead_in"].endswith("is contraindicated in patients with:")
