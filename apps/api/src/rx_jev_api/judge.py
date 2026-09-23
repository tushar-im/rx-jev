"""Asks Jev what one label says about every catalog question, in a single request.

Each question gets two Choice judgments over the same state:

- **stance**, over the five fixed answer categories;
- **evidence**, over the IDs of the question's candidate sentences plus `none`.

Code decides the candidates (catalog sections, split into sentences). Jev only selects, and
the quote people see is always the candidate's verbatim text. A question with no candidate
sections, or more candidates than a Choice can hold, is skipped rather than truncated: the
model cannot pick a sentence it was never shown.
"""

import hashlib
import json
from time import perf_counter
from typing import Any, Literal

from pydantic import BaseModel
from typesafe_sdk import Choice, ChoiceAnswer, TypeSafeClient, TypeSafeError

from rx_jev_api.catalog import CATALOG, QuestionId, candidate_sections
from rx_jev_api.clients.openfda import Label
from rx_jev_api.sentences import Candidate, label_candidates

__all__ = [
    "MAX_CHOICE_OPTIONS",
    "NONE",
    "STANCES",
    "Distribution",
    "Judge",
    "JudgeError",
    "JudgeRequest",
    "JudgeResult",
    "Kind",
    "SkipReason",
    "Stance",
    "build_request",
    "question_key",
]

Stance = Literal["warns_against", "caution", "dose_change", "no_known_issue", "not_mentioned"]
STANCES: tuple[Stance, ...] = (
    "warns_against",
    "caution",
    "dose_change",
    "no_known_issue",
    "not_mentioned",
)
Kind = Literal["stance", "evidence"]
SkipReason = Literal["no_sections", "too_many_candidates"]

NONE = "none"
# A Choice question accepts at most this many options, `none` included.
MAX_CHOICE_OPTIONS = 255

_STANCE_CRITERIA: dict[str, str] = {
    "warns_against": (
        "The label says not to use this drug, or says it is contraindicated, for the subject "
        "of the question."
    ),
    "caution": (
        "The label says to ask a doctor first, use caution, or monitor, for the subject of the "
        "question, without saying not to use the drug."
    ),
    "dose_change": "The label gives a different dose or dosing schedule for the subject.",
    "no_known_issue": (
        "The label explicitly says no problem, risk, or dose change is known for the subject."
    ),
    "not_mentioned": (
        "The listed sections do not address the subject at all. Silence is not the same as "
        "saying no problem is known."
    ),
}

_READING_RULES = [
    "Judge only from the sentences in the listed sections, not from outside knowledge.",
    "A sentence given with a `lead_in` continues that lead-in; read the two together.",
]


class JudgeError(Exception):
    """Jev is not configured, failed, or answered outside a question's options."""


class JudgeRequest(BaseModel, frozen=True):
    state: dict[str, Any]
    questions: dict[str, Choice]
    # Questions sent to Jev, with the candidates their evidence question offers.
    asked: dict[QuestionId, list[Candidate]]
    skipped: dict[QuestionId, SkipReason]
    # Identifies the exact request, so stored judgments are reused only for identical input.
    prompt_hash: str


class Distribution(BaseModel, frozen=True):
    choice: str
    confidence: float
    probabilities: dict[str, float]


class JudgeResult(BaseModel, frozen=True):
    model_version: str
    latency_ms: int
    input_tokens: int | None
    output_tokens: int | None
    # Keyed by question_key(question_id, kind).
    distributions: dict[str, Distribution]


def question_key(question_id: str, kind: Kind) -> str:
    return f"{question_id}.{kind}"


def build_request(label: Label) -> JudgeRequest:
    asked: dict[QuestionId, list[Candidate]] = {}
    skipped: dict[QuestionId, SkipReason] = {}
    questions: dict[str, Choice] = {}

    for question in CATALOG:
        sections = candidate_sections(question.id, label)
        candidates = label_candidates(label, sections)
        if not candidates:
            skipped[question.id] = "no_sections"
            continue
        if len(candidates) + 1 > MAX_CHOICE_OPTIONS:
            skipped[question.id] = "too_many_candidates"
            continue

        asked[question.id] = candidates
        paths = [f"`drug_label.sections.{name}`" for name in sections]
        questions[question_key(question.id, "stance")] = Choice(
            instructions={
                "question": f"What does this drug label say about {question.subject}?",
                "read_only": paths,
                "rules": _READING_RULES,
            },
            criteria=_STANCE_CRITERIA,
        )
        questions[question_key(question.id, "evidence")] = Choice(
            instructions={
                "question": (
                    f"Which sentence best shows what this drug label says about {question.subject}?"
                ),
                "read_only": paths,
                "options": (
                    "Each option is the id of one sentence in the listed sections. Choose "
                    f"`{NONE}` if no listed sentence addresses the subject."
                ),
                "rules": _READING_RULES,
            },
            criteria={c.id: None for c in candidates}
            | {NONE: f"No sentence in the listed sections addresses {question.subject}."},
        )

    state = {
        "drug_label": {
            "product_type": label.product_type,
            "ingredients": label.substance_names,
            "sections": _sections_state(asked),
        }
    }
    return JudgeRequest(
        state=state,
        questions=questions,
        asked=asked,
        skipped=skipped,
        prompt_hash=_hash(state, questions),
    )


class Judge:
    def __init__(self, client: TypeSafeClient | None, model: str) -> None:
        self._client = client
        self._model = model

    def judge(self, request: JudgeRequest) -> JudgeResult:
        if not request.questions:
            return JudgeResult(
                model_version=self._model,
                latency_ms=0,
                input_tokens=0,
                output_tokens=0,
                distributions={},
            )
        if self._client is None:
            raise JudgeError("TYPESAFE_API_KEY is not configured.")

        started = perf_counter()
        try:
            response = self._client.system_one(
                state=request.state, questions=request.questions, model=self._model
            )
        except TypeSafeError as exc:
            raise JudgeError("The Jev request failed.") from exc
        latency_ms = round((perf_counter() - started) * 1000)

        distributions = {
            key: _distribution(key, question, response.answers.get(key))
            for key, question in request.questions.items()
        }
        return JudgeResult(
            model_version=response.model,
            latency_ms=latency_ms,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            distributions=distributions,
        )


def _sections_state(asked: dict[QuestionId, list[Candidate]]) -> dict[str, dict[str, Any]]:
    sections: dict[str, dict[str, Any]] = {}
    for candidates in asked.values():
        for c in candidates:
            entry = c.text if c.lead_in is None else {"lead_in": c.lead_in.text, "text": c.text}
            sections.setdefault(c.section, {})[c.id] = entry
    return sections


def _hash(state: dict[str, Any], questions: dict[str, Choice]) -> str:
    body = {
        "state": state,
        "questions": {k: q.model_dump(mode="json") for k, q in questions.items()},
    }
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _distribution(key: str, question: Choice, answer: object) -> Distribution:
    if not isinstance(answer, ChoiceAnswer):
        raise JudgeError(f"Jev returned no choice answer for {key}.")
    options = set(question.criteria)
    if answer.choice not in options or not set(answer.probabilities) <= options:
        raise JudgeError(f"Jev answered {key} outside its options.")
    # Keep the full distribution: options Jev left out carry zero probability.
    probabilities = {o: answer.probabilities.get(o, 0.0) for o in question.criteria}
    return Distribution(
        choice=answer.choice, confidence=answer.confidence, probabilities=probabilities
    )
