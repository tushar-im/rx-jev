import pytest

from rx_jev_api.clients.openfda import CanonicalLabels, OpenFdaClient
from rx_jev_api.sentences import label_candidates, split_section
from tests.recorded import openfda_http


def texts(section: str, text: str) -> list[str]:
    return [c.text for c in split_section(section, text)]


@pytest.fixture(scope="module")
def recorded_labels() -> list[CanonicalLabels]:
    client = OpenFdaClient(openfda_http())
    drugs = [["ibuprofen"], ["metformin"], ["acetaminophen", "diphenhydramine"], ["loratadine"]]
    return [client.canonical_labels(d) for d in drugs]


def test_splits_on_sentence_ends() -> None:
    assert texts("w", "Stop use if rash occurs. Ask a doctor! Is it red? Yes.") == [
        "Stop use if rash occurs.",
        "Ask a doctor!",
        "Is it red?",
        "Yes.",
    ]


def test_splits_on_bullets() -> None:
    assert texts(
        "d", "Directions ■ do not take more ■ adults: • take 1 tablet ▪ children: ask"
    ) == [
        "Directions",
        "do not take more",
        "adults:",
        "take 1 tablet",
        "children: ask",
    ]


def test_does_not_split_decimals_lowercase_continuations_or_abbreviations() -> None:
    text = (
        "Avoid if eGFR is below 1.73 mL/min. Other NSAIDs, e.g. Aspirin, may add risk. "
        "Take 2.5 mg. daily with food. Dr. Smith is not a real reference."
    )

    assert texts("w", text) == [
        "Avoid if eGFR is below 1.73 mL/min.",
        "Other NSAIDs, e.g. Aspirin, may add risk.",
        "Take 2.5 mg. daily with food.",
        "Dr. Smith is not a real reference.",
    ]


def test_drops_pieces_without_letters() -> None:
    assert texts("c", "• • Hypersensitivity to metformin. ( 4 ) • 12.") == [
        "Hypersensitivity to metformin. ( 4 )",
    ]


def test_blank_section_has_no_candidates() -> None:
    assert split_section("w", "  \n ") == []


def test_ids_are_section_scoped_and_sequential() -> None:
    candidates = split_section("pregnancy", "One. Two. Three.")

    assert [c.id for c in candidates] == ["pregnancy:1", "pregnancy:2", "pregnancy:3"]
    assert all(c.section == "pregnancy" for c in candidates)


def test_label_candidates_follow_the_requested_section_order(
    recorded_labels: list[CanonicalLabels],
) -> None:
    label = recorded_labels[0].otc
    assert label is not None

    candidates = label_candidates(label, ["ask_doctor", "do_not_use"])

    sections = [c.section for c in candidates]
    assert sections == sorted(sections, key=["ask_doctor", "do_not_use"].index)
    assert {"ask_doctor", "do_not_use"} == set(sections)


def test_unbulleted_otc_block_stays_one_candidate(recorded_labels: list[CanonicalLabels]) -> None:
    label = recorded_labels[0].otc
    assert label is not None

    candidates = split_section("do_not_use", label.sections["do_not_use"])

    assert [c.text for c in candidates] == [label.sections["do_not_use"].strip()]


def test_prescription_bullets_become_separate_candidates(
    recorded_labels: list[CanonicalLabels],
) -> None:
    label = recorded_labels[1].prescription
    assert label is not None

    found = texts("contraindications", label.sections["contraindications"])

    assert "Hypersensitivity to metformin." in found


def test_every_candidate_is_a_verbatim_span_of_real_label_text(
    recorded_labels: list[CanonicalLabels],
) -> None:
    checked = 0
    for canonical in recorded_labels:
        for label in (canonical.otc, canonical.prescription):
            if label is None:
                continue
            for section, text in label.sections.items():
                for c in split_section(section, text):
                    assert c.text == text[c.start : c.end]
                    assert c.text == c.text.strip() and c.text
                    checked += 1

    assert checked > 500
