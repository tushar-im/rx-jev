"""RFC 7807 Problem Details for every error the API returns."""

import logging
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_JSON = "application/problem+json"

logger = logging.getLogger(__name__)


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


async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    # Log the real cause server-side; never send it to the client.
    logger.error("Unhandled exception on %s %s", request.method, request.url.path, exc_info=exc)
    return problem(500, "An unexpected error occurred.")


def register_problem_handlers(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, _http_error)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _validation_error)  # type: ignore[arg-type]
    # Registered on Exception, Starlette routes this through ServerErrorMiddleware,
    # so it only runs for errors the handlers above did not catch.
    app.add_exception_handler(Exception, _unhandled_error)
