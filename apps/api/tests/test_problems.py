from typing import Annotated

import pytest
from fastapi import FastAPI, HTTPException, Query
from fastapi.testclient import TestClient

from rx_jev_api.problems import PROBLEM_JSON, register_problem_handlers


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    register_problem_handlers(app)

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("secret internal detail")

    @app.get("/teapot")
    def teapot() -> None:
        raise HTTPException(status_code=418, detail="short and stout")

    @app.get("/slow-down")
    def slow_down() -> None:
        raise HTTPException(status_code=429, detail="Too many.", headers={"Retry-After": "30"})

    @app.get("/needs-int")
    def needs_int(n: Annotated[int, Query()]) -> int:
        return n

    # The server error middleware re-raises after responding; we want the response.
    return TestClient(app, raise_server_exceptions=False)


def test_unhandled_exception_returns_500_problem_details(client: TestClient) -> None:
    response = client.get("/boom")

    assert response.status_code == 500
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json() == {
        "type": "about:blank",
        "title": "Internal Server Error",
        "status": 500,
        "detail": "An unexpected error occurred.",
    }


def test_unhandled_exception_does_not_leak_internals(client: TestClient) -> None:
    response = client.get("/boom")

    assert "secret internal detail" not in response.text
    assert "RuntimeError" not in response.text


def test_http_exception_handler_is_preserved(client: TestClient) -> None:
    response = client.get("/teapot")

    assert response.status_code == 418
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["detail"] == "short and stout"


def test_http_exception_headers_are_kept(client: TestClient) -> None:
    response = client.get("/slow-down")

    assert response.status_code == 429
    assert response.headers["retry-after"] == "30"
    assert response.headers["content-type"].startswith(PROBLEM_JSON)


def test_validation_handler_is_preserved(client: TestClient) -> None:
    response = client.get("/needs-int", params={"n": "not-a-number"})

    assert response.status_code == 422
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["detail"] == "Invalid request: query.n"
