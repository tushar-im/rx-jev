from collections.abc import Iterator
from typing import Annotated

import httpx
from fastapi import Depends

from rx_jev_api.clients.openfda import OpenFdaClient
from rx_jev_api.clients.rxnorm import RxNormClient
from rx_jev_api.config import Settings, get_settings

UPSTREAM_TIMEOUT = httpx.Timeout(20.0)

SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_rxnorm_client(settings: SettingsDep) -> Iterator[RxNormClient]:
    with httpx.Client(base_url=settings.rxnorm_base_url, timeout=UPSTREAM_TIMEOUT) as http:
        yield RxNormClient(http)


def get_openfda_client(settings: SettingsDep) -> Iterator[OpenFdaClient]:
    key = settings.openfda_api_key.get_secret_value() if settings.openfda_api_key else None
    with httpx.Client(base_url=settings.openfda_base_url, timeout=UPSTREAM_TIMEOUT) as http:
        yield OpenFdaClient(http, key)


RxNormDep = Annotated[RxNormClient, Depends(get_rxnorm_client)]
OpenFdaDep = Annotated[OpenFdaClient, Depends(get_openfda_client)]
