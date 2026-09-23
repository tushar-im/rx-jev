import pytest

from rx_jev_api.clients.openfda import Label, OpenFdaClient
from tests.recorded import openfda_http


@pytest.fixture(scope="session")
def metformin_rx() -> Label:
    label = OpenFdaClient(openfda_http()).canonical_labels(["metformin"]).prescription
    assert label is not None
    return label


@pytest.fixture(scope="session")
def ibuprofen_otc() -> Label:
    label = OpenFdaClient(openfda_http()).canonical_labels(["ibuprofen"]).otc
    assert label is not None
    return label
