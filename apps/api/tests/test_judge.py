from datetime import date

import pytest

from rx_jev_api.catalog import CATALOG, candidate_sections
from rx_jev_api.clients.openfda import Label
from rx_jev_api.judge import (
    MAX_CHOICE_OPTIONS,
    NONE,
    STANCES,
    Judge,
    JudgeError,
    build_request,
    question_key,
)
from rx_jev_api.sentences import label_candidates
from tests.jev import MODEL_VERSION, FakeJev


def long_label(sentences: int) -> Label:
    text = " ".join(f"Sentence number {n} is here." for n in range(sentences))
    return Label(
        set_id="s",
        version="1",
        effective_time=date(2026, 1, 1),
        product_type="prescription",
        brand_name=None,
        manufacturer_name=None,
        substance_names=["X"],
        is_original_packager=True,
        sections={"pregnancy": "Pregnancy is discussed here.", "contraindications": text},
    )


def test_every_catalog_question_has_a_subject() -> None:
    assert all(q.subject.strip() for q in CATALOG)


def test_asks_stance_and_evidence_for_every_question_with_candidates(
    metformin_rx: Label,
) -> None:
    request = build_request(metformin_rx)
    asked = [q.id for q in CATALOG if candidate_sections(q.id, metformin_rx)]
    assert list(request.asked) == asked
    assert set(request.questions) == {
        question_key(q, kind) for q in asked for kind in ("stance", "evidence")
    }


def test_stance_options_are_the_five_fixed_categories(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    for question_id in request.asked:
        criteria = request.questions[question_key(question_id, "stance")].criteria
        assert tuple(criteria) == STANCES
        assert all(criteria.values())
    assert STANCES == (
        "warns_against",
        "caution",
        "dose_change",
        "no_known_issue",
        "not_mentioned",
    )


def test_evidence_options_are_candidate_ids_plus_none(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    for question_id, candidates in request.asked.items():
        sections = candidate_sections(question_id, metformin_rx)
        expected = [c.id for c in label_candidates(metformin_rx, sections)]
        assert [c.id for c in candidates] == expected
        criteria = request.questions[question_key(question_id, "evidence")].criteria
        assert list(criteria) == [*expected, NONE]


def test_state_holds_every_candidate_verbatim_by_id(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    sections = request.state["drug_label"]["sections"]
    for candidates in request.asked.values():
        for c in candidates:
            entry = sections[c.section][c.id]
            if c.lead_in is None:
                assert entry == c.text
            else:
                assert entry == {"lead_in": c.lead_in.text, "text": c.text}


def test_state_holds_only_sections_some_question_uses(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    used = {c.section for candidates in request.asked.values() for c in candidates}
    assert set(request.state["drug_label"]["sections"]) == used


def test_instructions_name_the_subject_and_the_sections_to_read(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    pregnancy = next(q for q in CATALOG if q.id == "pregnancy")
    for kind in ("stance", "evidence"):
        text = str(request.questions[question_key("pregnancy", kind)].instructions)
        assert pregnancy.subject in text
        for section in candidate_sections("pregnancy", metformin_rx):
            assert f"`drug_label.sections.{section}`" in text


def test_question_without_sections_is_skipped(ibuprofen_otc: Label) -> None:
    request = build_request(ibuprofen_otc)
    assert request.skipped["boxed_warning"] == "no_sections"
    assert "boxed_warning" not in request.asked


def test_question_over_the_option_limit_is_skipped_not_truncated() -> None:
    request = build_request(long_label(MAX_CHOICE_OPTIONS))
    assert request.skipped["allergy"] == "too_many_candidates"
    assert "allergy" not in request.asked
    assert "pregnancy" in request.asked


def test_prompt_hash_is_stable_and_tracks_label_text(metformin_rx: Label) -> None:
    assert build_request(metformin_rx).prompt_hash == build_request(metformin_rx).prompt_hash
    changed = metformin_rx.model_copy(
        update={"sections": metformin_rx.sections | {"pregnancy": "Changed text."}}
    )
    assert build_request(changed).prompt_hash != build_request(metformin_rx).prompt_hash


def test_judge_sends_all_questions_in_one_request(metformin_rx: Label) -> None:
    jev = FakeJev()
    request = build_request(metformin_rx)
    Judge(jev.client(), "jev-latest").judge(request)
    assert len(jev.requests) == 1
    body = jev.requests[0]
    assert body["model"] == "jev-latest"
    assert set(body["questions"]) == set(request.questions)
    assert body["state"] == request.state


def test_judge_returns_full_distributions_and_usage(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    result = Judge(FakeJev().client(), "jev-latest").judge(request)
    assert result.model_version == MODEL_VERSION
    assert (result.input_tokens, result.output_tokens) == (1234, 56)
    assert result.latency_ms >= 0
    assert set(result.distributions) == set(request.questions)
    stance = result.distributions[question_key("pregnancy", "stance")]
    assert stance.choice == "warns_against"
    assert set(stance.probabilities) == set(STANCES)
    assert stance.confidence == 0.8


def test_judge_without_api_key_fails_cleanly(metformin_rx: Label) -> None:
    with pytest.raises(JudgeError):
        Judge(None, "jev-latest").judge(build_request(metformin_rx))


def test_judge_wraps_api_failures(metformin_rx: Label) -> None:
    with pytest.raises(JudgeError):
        Judge(FakeJev(status=529).client(), "jev-latest").judge(build_request(metformin_rx))


def test_judge_rejects_a_choice_outside_the_options(metformin_rx: Label) -> None:
    jev = FakeJev(pick=lambda key, options: "made_up")
    with pytest.raises(JudgeError):
        Judge(jev.client(), "jev-latest").judge(build_request(metformin_rx))


def test_judge_rejects_a_missing_answer(metformin_rx: Label) -> None:
    jev = FakeJev(drop={question_key("pregnancy", "evidence")})
    with pytest.raises(JudgeError):
        Judge(jev.client(), "jev-latest").judge(build_request(metformin_rx))
