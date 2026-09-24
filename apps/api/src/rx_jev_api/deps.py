from collections.abc import Iterator, Sequence
from functools import lru_cache
from typing import Annotated

import httpx
from fastapi import Depends
from sqlalchemy import Engine
from sqlmodel import Session
from typesafe_sdk import RetryPolicy, TypeSafeClient

from rx_jev_api.clients.openfda import OpenFdaClient
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.config import Settings, get_settings
from rx_jev_api.db import make_engine
from rx_jev_api.judge import Judge
from rx_jev_api.ratelimit import Limit, RateLimiter
from rx_jev_api.store import Store

UPSTREAM_TIMEOUT = httpx.Timeout(20.0)
# One Jev request carries a whole label (roughly 30K tokens for long prescription labels).
JEV_TIMEOUT = 60.0
# The SDK retries 429, 529 and other 5xx with backoff by default; this caps the total wait.
JEV_RETRY = RetryPolicy(timeout=120.0)

SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_rxnorm_client(settings: SettingsDep) -> Iterator[RxNormClient]:
    with httpx.Client(base_url=settings.rxnorm_base_url, timeout=UPSTREAM_TIMEOUT) as http:
        yield RxNormClient(http)


@lru_cache
def _drug_names(base_url: str) -> tuple[str, ...]:
    # Fetched once per process; a failed fetch raises and is retried on the next request.
    with httpx.Client(base_url=base_url, timeout=UPSTREAM_TIMEOUT) as http:
        return tuple(RxNormClient(http).display_names())


def get_drug_names(settings: SettingsDep) -> Sequence[str]:
    return _drug_names(settings.rxnorm_base_url)


def get_openfda_client(settings: SettingsDep) -> Iterator[OpenFdaClient]:
    key = settings.openfda_api_key.get_secret_value() if settings.openfda_api_key else None
    with httpx.Client(base_url=settings.openfda_base_url, timeout=UPSTREAM_TIMEOUT) as http:
        yield OpenFdaClient(http, key)


def get_judge(settings: SettingsDep) -> Iterator[Judge]:
    # Without a key the judge still serves stored answers; only a store miss fails.
    if settings.typesafe_api_key is None:
        yield Judge(None, settings.typesafe_model)
        return
    with TypeSafeClient(
        api_key=settings.typesafe_api_key.get_secret_value(),
        timeout=JEV_TIMEOUT,
        retry=JEV_RETRY,
    ) as client:
        yield Judge(client, settings.typesafe_model)


@lru_cache
def _ask_limiter(per_minute: int, per_day: int) -> RateLimiter:
    # One limiter per process, shared by every request.
    return RateLimiter([Limit(count=per_minute, seconds=60), Limit(count=per_day, seconds=86_400)])


def get_ask_limiter(settings: SettingsDep) -> RateLimiter:
    return _ask_limiter(settings.ask_per_minute, settings.ask_per_day)


@lru_cache
def get_engine() -> Engine:
    return make_engine(get_settings().database_url)


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


def get_store(session: Annotated[Session, Depends(get_session)]) -> Store:
    return Store(session)


RxNormDep = Annotated[RxNormClient, Depends(get_rxnorm_client)]
DrugNamesDep = Annotated[Sequence[str], Depends(get_drug_names)]
OpenFdaDep = Annotated[OpenFdaClient, Depends(get_openfda_client)]
JudgeDep = Annotated[Judge, Depends(get_judge)]
StoreDep = Annotated[Store, Depends(get_store)]
AskLimiterDep = Annotated[RateLimiter, Depends(get_ask_limiter)]
