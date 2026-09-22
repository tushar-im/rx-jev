from datetime import date

import pytest

from rx_jev_api.catalog import CATALOG, candidate_sections, get_question, label_format
from rx_jev_api.clients.openfda import Label, OpenFdaClient, ProductType
from tests.recorded import openfda_http


@pytest.fixture(scope="module")
def client() -> OpenFdaClient:
    return OpenFdaClient(openfda_http())


def label_with(sections: dict[str, str], product_type: ProductType = "otc") -> Label:
    return Label(
        set_id="s",
        version="1",
        effective_time=date(2026, 1, 1),
        product_type=product_type,
        brand_name=None,
        manufacturer_name=None,
        substance_names=["X"],
        is_original_packager=True,
        sections=sections,
    )


def test_catalog_ids_are_unique_and_grouped() -> None:
    ids = [q.id for q in CATALOG]

    assert len(ids) == len(set(ids)) == 19
    assert {q.group for q in CATALOG} == {
        "who",
        "conditions",
        "combinations",
        "daily_life",
        "serious",
    }
    assert all(q.title.strip() for q in CATALOG)


def test_unknown_question_raises_key_error() -> None:
    with pytest.raises(KeyError):
        get_question("is_it_safe")


def test_otc_label_uses_otc_sections(client: OpenFdaClient) -> None:
    label = client.canonical_labels(["ibuprofen"]).otc
    assert label is not None

    assert label_format(label) == "otc"
    assert candidate_sections("pregnancy", label) == ["pregnancy_or_breast_feeding"]
    assert candidate_sections("kidney", label) == ["do_not_use", "ask_doctor", "warnings"]
    assert candidate_sections("blood_thinners", label) == ["ask_doctor_or_pharmacist"]


def test_modern_prescription_label_uses_plr_sections(client: OpenFdaClient) -> None:
    label = client.canonical_labels(["metformin"]).prescription
    assert label is not None

    assert label_format(label) == "prescription"
    assert candidate_sections("pregnancy", label) == ["pregnancy", "use_in_specific_populations"]
    assert candidate_sections("kidney", label) == [
        "contraindications",
        "warnings_and_cautions",
        "use_in_specific_populations",
    ]
    assert candidate_sections("boxed_warning", label) == ["boxed_warning"]


def test_older_prescription_label_falls_back_to_warnings_and_precautions(
    client: OpenFdaClient,
) -> None:
    label = client.canonical_labels(["ibuprofen"]).prescription
    assert label is not None

    assert candidate_sections("kidney", label) == ["contraindications", "warnings", "precautions"]
    assert candidate_sections("alcohol", label) == ["warnings", "precautions", "drug_interactions"]


def test_mislabelled_prescription_with_otc_sections_is_read_as_otc(client: OpenFdaClient) -> None:
    label = client.canonical_labels(["loratadine"]).prescription
    assert label is not None

    assert label.product_type == "prescription"
    assert label_format(label) == "otc"
    assert candidate_sections("pregnancy", label) == ["pregnancy_or_breast_feeding"]


def test_boxed_warning_has_no_candidates_on_otc_labels() -> None:
    label = label_with({"do_not_use": "Do not use if allergic.", "boxed_warning": "Odd."})

    assert candidate_sections("boxed_warning", label) == []


def test_blank_sections_are_not_candidates() -> None:
    label = label_with({"do_not_use": "   ", "ask_doctor": "Ask a doctor if you have asthma."})

    assert candidate_sections("asthma", label) == ["ask_doctor"]


def test_section_order_follows_the_catalog_not_the_label() -> None:
    label = label_with({"warnings": "W.", "ask_doctor": "A.", "do_not_use": "D."})

    assert candidate_sections("diabetes", label) == ["do_not_use", "ask_doctor", "warnings"]


def test_blank_otc_marker_does_not_flip_a_prescription_label_to_otc() -> None:
    label = label_with(
        {"do_not_use": "  ", "boxed_warning": "WARNING: LACTIC ACIDOSIS."},
        product_type="prescription",
    )

    assert label_format(label) == "prescription"
    assert candidate_sections("boxed_warning", label) == ["boxed_warning"]
