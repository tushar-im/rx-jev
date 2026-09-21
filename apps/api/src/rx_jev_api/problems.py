"""RFC 7807 Problem Details for every error the API returns."""

from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_JSON = "application/problem+json"


def problem(status: int, detail: str, type_: str = "about:blank") -> JSONResponse:
    return JSONResponse(
        status_code=status,
        media_type=PROBLEM_JSON,
        content={
            "type": type_,
            "title": HTTPStatus(status).phrase,
            "status": status,
            "detail": detail,
        },
    )


async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    return problem(exc.status_code, str(exc.detail))


async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    fields = ", ".join(".".join(str(p) for p in err["loc"]) for err in exc.errors())
    return problem(422, f"Invalid request: {fields}")


def register_problem_handlers(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, _http_error)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _validation_error)  # type: ignore[arg-type]
