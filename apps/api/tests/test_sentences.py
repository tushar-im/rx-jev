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


def lead_ins(section: str, text: str) -> list[tuple[str, str | None]]:
    return [(c.text, c.lead_in.text if c.lead_in else None) for c in split_section(section, text)]


def test_bullets_carry_their_governing_lead_in() -> None:
    text = (
        "Metformin is contraindicated in patients with: • Severe renal impairment. "
        "• Hypersensitivity to metformin."
    )

    assert lead_ins("contraindications", text) == [
        ("Metformin is contraindicated in patients with:", None),
        ("Severe renal impairment.", "Metformin is contraindicated in patients with:"),
        ("Hypersensitivity to metformin.", "Metformin is contraindicated in patients with:"),
    ]


def test_otc_heading_without_colon_is_a_lead_in() -> None:
    assert lead_ins(
        "stop_use", "Stop use and ask a doctor if • you feel faint • pain gets worse"
    ) == [
        ("Stop use and ask a doctor if", None),
        ("you feel faint", "Stop use and ask a doctor if"),
        ("pain gets worse", "Stop use and ask a doctor if"),
    ]


def test_nested_list_uses_inner_lead_in_and_self_contained_items_use_outer() -> None:
    text = (
        "Directions ■ do not take more than directed ■ adults and children 12 years and older: "
        "■ take 1 tablet every 4 to 6 hours ■ do not exceed 6 tablets in 24 hours "
        "■ children under 12 years: ask a doctor"
    )

    assert lead_ins("dosage_and_administration", text) == [
        ("Directions", None),
        ("do not take more than directed", "Directions"),
        ("adults and children 12 years and older:", "Directions"),
        ("take 1 tablet every 4 to 6 hours", "adults and children 12 years and older:"),
        ("do not exceed 6 tablets in 24 hours", "adults and children 12 years and older:"),
        ("children under 12 years: ask a doctor", "Directions"),
    ]


def test_new_list_after_prose_takes_a_new_lead_in() -> None:
    text = (
        "Intro: • Geriatric Use: Assess renal function. Other prose here. "
        "Use caution in patients with: • heart failure • sepsis"
    )

    assert lead_ins("w", text)[-2:] == [
        ("heart failure", "Use caution in patients with:"),
        ("sepsis", "Use caution in patients with:"),
    ]


def test_prose_and_later_sentences_in_an_item_have_no_lead_in() -> None:
    result = lead_ins("w", "Intro: • First item. Trailing prose.")

    assert result == [("Intro:", None), ("First item.", "Intro:"), ("Trailing prose.", None)]


def test_lead_in_is_a_verbatim_span(recorded_labels: list[CanonicalLabels]) -> None:
    checked = 0
    for canonical in recorded_labels:
        for label in (canonical.otc, canonical.prescription):
            if label is None:
                continue
            for section, text in label.sections.items():
                for c in split_section(section, text):
                    if c.lead_in is not None:
                        assert c.lead_in.text == text[c.lead_in.start : c.lead_in.end]
                        assert c.lead_in.end <= c.start
                        checked += 1

    assert checked > 20


def test_company_and_country_abbreviations_do_not_split() -> None:
    text = (
        "Made by Acme Pvt. Ltd. Sangareddy, India. Report to the U.S. Food and Drug Administration."
    )

    assert texts("w", text) == [
        "Made by Acme Pvt. Ltd. Sangareddy, India.",
        "Report to the U.S. Food and Drug Administration.",
    ]
