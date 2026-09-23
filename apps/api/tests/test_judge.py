import hashlib
from datetime import date

import pytest

from rx_jev_api.catalog import CATALOG, candidate_sections
from rx_jev_api.clients.openfda import Label
from rx_jev_api.judge import (
    MAX_CHOICE_OPTIONS,
    NONE,
    SHORTLIST_PER_CHUNK,
    STANCES,
    Judge,
    JudgeError,
    build_request,
    chunk_key,
    estimate_tokens,
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


def unanswerable_label() -> Label:
    # A real label layout, but none of the sections any catalog question reads.
    return long_label(0).model_copy(
        update={"sections": {"indications_and_usage": "Used to treat X in adults."}}
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


def test_children_stance_counts_unestablished_safety_as_caution(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    children = str(request.questions[question_key("children", "stance")].instructions)
    assert "not been established" in children and "`caution`" in children
    pregnancy = str(request.questions[question_key("pregnancy", "stance")].instructions)
    assert "not been established" not in pregnancy


def test_question_without_sections_is_skipped(ibuprofen_otc: Label) -> None:
    request = build_request(ibuprofen_otc)
    assert request.skipped["boxed_warning"] == "no_sections"
    assert "boxed_warning" not in request.asked


def test_evidence_over_the_option_limit_is_split_into_chunks_not_truncated() -> None:
    request = build_request(long_label(MAX_CHOICE_OPTIONS))
    candidates = [c.id for c in request.asked["allergy"]]
    assert len(candidates) >= MAX_CHOICE_OPTIONS
    assert "allergy" not in request.skipped

    chunks = request.evidence_chunks["allergy"].chunks
    assert len(chunks) == 2
    assert [cid for chunk in chunks for cid in chunk] == candidates
    assert question_key("allergy", "evidence") not in request.questions
    for n, chunk in enumerate(chunks):
        criteria = request.questions[chunk_key("allergy", n)].criteria
        assert list(criteria) == [*chunk, NONE]
        assert len(criteria) <= MAX_CHOICE_OPTIONS


def test_stance_is_asked_when_evidence_is_chunked() -> None:
    request = build_request(long_label(MAX_CHOICE_OPTIONS))
    stance = request.questions[question_key("allergy", "stance")]
    assert tuple(stance.criteria) == STANCES


def test_evidence_within_the_option_limit_is_not_chunked(metformin_rx: Label) -> None:
    assert build_request(metformin_rx).evidence_chunks == {}


def test_chunked_evidence_is_decided_by_a_second_request_over_a_shortlist() -> None:
    jev = FakeJev()
    request = build_request(long_label(MAX_CHOICE_OPTIONS))
    result = Judge(jev.client(), "jev-latest").judge(request)

    assert len(jev.requests) == len(request.parts) + 1
    final = jev.requests[-1]
    chunked = set(request.evidence_chunks)
    assert set(final["questions"]) == {question_key(q, "evidence") for q in chunked}

    # Each chunk contributes its most probable sentences, in label order, plus `none`.
    chunks = request.evidence_chunks["allergy"].chunks
    shortlist = [cid for chunk in chunks for cid in chunk[:SHORTLIST_PER_CHUNK]]
    options = list(final["questions"][question_key("allergy", "evidence")]["criteria"])
    assert options == [*shortlist, NONE]
    sections = final["state"]["drug_label"]["sections"]
    assert {cid for entries in sections.values() for cid in entries} == set(shortlist)

    assert set(result.distributions) == {
        question_key(q, kind) for q in request.asked for kind in ("stance", "evidence")
    }
    assert result.distributions[question_key("allergy", "evidence")].choice == shortlist[0]
    assert result.input_tokens == 1234 * len(jev.requests)


def test_shortlist_follows_each_chunk_s_probabilities() -> None:
    request = build_request(long_label(MAX_CHOICE_OPTIONS))
    chunks = request.evidence_chunks["allergy"].chunks
    favourites = {chunk_key("allergy", n): chunk[-1] for n, chunk in enumerate(chunks)}

    def pick(key: str, options: list[str]) -> str:
        return favourites.get(key, options[0])

    jev = FakeJev(pick=pick)
    Judge(jev.client(), "jev-latest").judge(request)
    options = jev.requests[-1]["questions"][question_key("allergy", "evidence")]["criteria"]
    for chunk in chunks:
        assert chunk[-1] in options


def test_all_chunks_answering_none_still_asks_the_shortlist() -> None:
    jev = FakeJev(pick=lambda key, options: NONE if NONE in options else options[0])
    request = build_request(long_label(MAX_CHOICE_OPTIONS))
    result = Judge(jev.client(), "jev-latest").judge(request)
    assert result.distributions[question_key("allergy", "evidence")].choice == NONE
    assert len(jev.requests) == len(request.parts) + 1


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


def test_a_label_that_fits_is_sent_as_one_part(metformin_rx: Label) -> None:
    request = build_request(metformin_rx)
    [part] = request.parts
    assert part.state == request.state
    assert part.questions == request.questions


def test_an_oversized_label_splits_by_question_under_the_budget(metformin_rx: Label) -> None:
    budget = 12_000
    request = build_request(metformin_rx, max_tokens=budget)
    assert len(request.parts) > 1

    keys = [key for part in request.parts for key in part.questions]
    assert sorted(keys) == sorted(request.questions)
    for part in request.parts:
        assert estimate_tokens(part.state, part.questions) <= budget
        question_ids = {key.rsplit(".", 1)[0] for key in part.questions}
        for question_id in question_ids:
            assert question_key(question_id, "stance") in part.questions
            assert question_key(question_id, "evidence") in part.questions
        used = {c.section for q in question_ids for c in request.asked[q]}
        assert set(part.state["drug_label"]["sections"]) == used


def test_a_question_too_long_for_any_part_is_skipped(metformin_rx: Label) -> None:
    request = build_request(metformin_rx, max_tokens=3_000)
    assert request.skipped["kidney"] == "too_long"
    assert "kidney" not in request.asked
    assert question_key("kidney", "stance") not in request.questions
    assert "older_adults" in request.asked
    assert all(estimate_tokens(p.state, p.questions) <= 3_000 for p in request.parts)


def test_prompt_hash_covers_how_the_label_was_split(metformin_rx: Label) -> None:
    whole = build_request(metformin_rx).prompt_hash
    assert build_request(metformin_rx, max_tokens=12_000).prompt_hash != whole


def test_judge_sends_one_call_per_part_and_merges_the_answers(metformin_rx: Label) -> None:
    jev = FakeJev()
    request = build_request(metformin_rx, max_tokens=12_000)
    result = Judge(jev.client(), "jev-latest").judge(request)
    assert len(jev.requests) == len(request.parts)
    assert [set(body["questions"]) for body in jev.requests] == [
        set(part.questions) for part in request.parts
    ]
    assert set(result.distributions) == set(request.questions)
    assert result.input_tokens == 1234 * len(request.parts)
    assert result.output_tokens == 56 * len(request.parts)


def test_a_label_with_every_question_skipped_has_no_parts_and_a_stable_hash() -> None:
    label = unanswerable_label()
    request = build_request(label)
    assert request.parts == []
    assert request.questions == {}
    assert set(request.skipped) == {q.id for q in CATALOG}
    assert build_request(label).prompt_hash == request.prompt_hash
    assert request.prompt_hash == hashlib.sha256(b"[]").hexdigest()


def test_judge_rejects_a_missing_answer(metformin_rx: Label) -> None:
    jev = FakeJev(drop={question_key("pregnancy", "evidence")})
    with pytest.raises(JudgeError):
        Judge(jev.client(), "jev-latest").judge(build_request(metformin_rx))
