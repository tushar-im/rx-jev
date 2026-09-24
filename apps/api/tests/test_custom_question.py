from rx_jev_api.catalog import CATALOG, candidate_sections, custom_sections
from rx_jev_api.clients.openfda import Label
from rx_jev_api.judge import (
    CUSTOM,
    MAX_CHOICE_OPTIONS,
    NONE,
    STANCES,
    Judge,
    build_custom_request,
    build_request,
    chunk_key,
    question_key,
)
from rx_jev_api.sentences import label_candidates
from tests.jev import FakeJev
from tests.test_judge import long_label, unanswerable_label

GRAPEFRUIT = "Can I drink grapefruit juice while taking this?"


def test_custom_sections_are_every_section_the_catalog_reads_in_catalog_order(
    metformin_rx: Label,
) -> None:
    expected = list(
        dict.fromkeys(s for q in CATALOG for s in candidate_sections(q.id, metformin_rx))
    )
    assert custom_sections(metformin_rx) == expected
    assert set(expected) == set(build_request(metformin_rx).state["drug_label"]["sections"])


def test_custom_question_asks_stance_and_evidence_once(metformin_rx: Label) -> None:
    request = build_custom_request(metformin_rx, GRAPEFRUIT)
    assert list(request.asked) == [CUSTOM]
    assert set(request.questions) == {
        question_key(CUSTOM, "stance"),
        question_key(CUSTOM, "evidence"),
    }
    assert len(request.parts) == 1


def test_custom_stance_keeps_the_five_fixed_categories(metformin_rx: Label) -> None:
    request = build_custom_request(metformin_rx, GRAPEFRUIT)
    stance = request.questions[question_key(CUSTOM, "stance")]
    assert tuple(stance.criteria) == STANCES


def test_custom_evidence_offers_every_candidate_of_the_custom_sections(
    metformin_rx: Label,
) -> None:
    request = build_custom_request(metformin_rx, GRAPEFRUIT)
    expected = [c.id for c in label_candidates(metformin_rx, custom_sections(metformin_rx))]
    assert [c.id for c in request.asked[CUSTOM]] == expected
    criteria = request.questions[question_key(CUSTOM, "evidence")].criteria
    assert list(criteria) == [*expected, NONE]


def test_reader_question_goes_into_the_instructions_verbatim_not_the_state(
    metformin_rx: Label,
) -> None:
    request = build_custom_request(metformin_rx, GRAPEFRUIT)
    assert set(request.state) == {"drug_label"}
    for kind in ("stance", "evidence"):
        instructions = request.questions[question_key(CUSTOM, kind)].instructions
        assert isinstance(instructions, dict)
        assert instructions["reader_question"] == GRAPEFRUIT
        assert "`reader_question`" in instructions["question"]
        assert any("not instructions" in rule for rule in instructions["rules"])
        for section in custom_sections(metformin_rx):
            assert f"`drug_label.sections.{section}`" in str(instructions)


def test_custom_question_with_no_sections_is_skipped() -> None:
    request = build_custom_request(unanswerable_label(), GRAPEFRUIT)
    assert request.skipped == {CUSTOM: "no_sections"}
    assert request.questions == {}


def test_custom_question_too_long_for_one_request_is_skipped(metformin_rx: Label) -> None:
    request = build_custom_request(metformin_rx, GRAPEFRUIT, max_tokens=3_000)
    assert request.skipped == {CUSTOM: "too_long"}
    assert request.parts == []


def test_custom_evidence_over_the_option_limit_is_chunked() -> None:
    label = long_label(MAX_CHOICE_OPTIONS)
    request = build_custom_request(label, GRAPEFRUIT)
    assert len(request.evidence_chunks[CUSTOM].chunks) == 2
    assert chunk_key(CUSTOM, 0) in request.questions

    result = Judge(FakeJev().client(), "jev-latest").judge(request)
    assert set(result.distributions) == {
        question_key(CUSTOM, "stance"),
        question_key(CUSTOM, "evidence"),
    }


def test_catalog_requests_carry_no_reader_question(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    assert CUSTOM not in request.asked
    assert "reader_question" not in str(request.questions)
