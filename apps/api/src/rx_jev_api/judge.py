"""Asks Jev what one label says about every catalog question.

Each question gets two Choice judgments over the same state:

- **stance**, over the five fixed answer categories;
- **evidence**, over the IDs of the question's candidate sentences plus `none`.

Code decides the candidates (catalog sections, split into sentences). Jev only selects, and
the quote people see is always the candidate's verbatim text. A question with no candidate
sections, more candidates than a Choice can hold, or more text than fits in one request is
skipped rather than truncated: the model cannot pick a sentence it was never shown.

All questions for a label go in one request when they fit. Jev rejects requests over its
input limit (`max_tokens_exceeded`), so a longer label is split into parts: whole questions,
in catalog order, each part carrying only the sections its own questions read.
"""

import hashlib
import json
import math
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
    "JudgePart",
    "JudgeRequest",
    "JudgeResult",
    "Kind",
    "SkipReason",
    "Stance",
    "build_request",
    "estimate_tokens",
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
SkipReason = Literal["no_sections", "too_many_candidates", "too_long"]

NONE = "none"
# A Choice question accepts at most this many options, `none` included.
MAX_CHOICE_OPTIONS = 255
# Jev's input limit is undocumented. The largest request accepted in the first review-set
# run was 61,989 input tokens; about 67K and up was rejected. With the conservative estimate
# below, a part at this budget stays under 55K real tokens.
MAX_REQUEST_TOKENS = 55_000
# Measured over 72 review-set requests: 2.77 to 3.48 characters of request JSON per input
# token. The low end keeps the estimate conservative.
CHARS_PER_TOKEN = 2.75

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


class JudgePart(BaseModel, frozen=True):
    """One Jev API call: some whole questions and only the sections they read."""

    state: dict[str, Any]
    questions: dict[str, Choice]


class JudgeRequest(BaseModel, frozen=True):
    # Everything asked about the label, as if it were one request.
    state: dict[str, Any]
    questions: dict[str, Choice]
    # How it is actually sent: one part unless the label is over the token budget.
    parts: list[JudgePart]
    # Questions sent to Jev, with the candidates their evidence question offers.
    asked: dict[QuestionId, list[Candidate]]
    skipped: dict[QuestionId, SkipReason]
    # Identifies exactly what Jev sees, so stored judgments are reused only for identical input.
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


def build_request(label: Label, max_tokens: int = MAX_REQUEST_TOKENS) -> JudgeRequest:
    asked: dict[QuestionId, list[Candidate]] = {}
    skipped: dict[QuestionId, SkipReason] = {}
    pairs: dict[QuestionId, dict[str, Choice]] = {}

    for question in CATALOG:
        sections = candidate_sections(question.id, label)
        candidates = label_candidates(label, sections)
        if not candidates:
            skipped[question.id] = "no_sections"
        elif len(candidates) + 1 > MAX_CHOICE_OPTIONS:
            skipped[question.id] = "too_many_candidates"
        else:
            asked[question.id] = candidates
            pairs[question.id] = _pair(question.id, question.subject, sections, candidates)

    parts: list[JudgePart] = []
    current: list[QuestionId] = []
    for question_id in list(asked):
        trial = _part(label, asked, pairs, [*current, question_id])
        if estimate_tokens(trial.state, trial.questions) <= max_tokens:
            current.append(question_id)
            continue
        alone = _part(label, asked, pairs, [question_id])
        if estimate_tokens(alone.state, alone.questions) > max_tokens:
            skipped[question_id] = "too_long"
            del asked[question_id]
            continue
        parts.append(_part(label, asked, pairs, current))
        current = [question_id]
    if current:
        parts.append(_part(label, asked, pairs, current))

    whole = _part(label, asked, pairs, list(asked))
    return JudgeRequest(
        state=whole.state,
        questions=whole.questions,
        parts=parts,
        asked=asked,
        skipped=dict(sorted(skipped.items(), key=lambda item: _ORDER[item[0]])),
        prompt_hash=_hash(parts),
    )


def estimate_tokens(state: dict[str, Any], questions: dict[str, Choice]) -> int:
    """A conservative estimate of the input tokens Jev counts for one request."""
    body = {
        "state": state,
        "questions": {k: q.model_dump(mode="json") for k, q in questions.items()},
    }
    return math.ceil(len(json.dumps(body, ensure_ascii=False)) / CHARS_PER_TOKEN)


_ORDER: dict[str, int] = {q.id: n for n, q in enumerate(CATALOG)}


def _part(
    label: Label,
    asked: dict[QuestionId, list[Candidate]],
    pairs: dict[QuestionId, dict[str, Choice]],
    question_ids: list[QuestionId],
) -> JudgePart:
    state = {
        "drug_label": {
            "product_type": label.product_type,
            "ingredients": label.substance_names,
            "sections": _sections_state([asked[q] for q in question_ids]),
        }
    }
    questions = {key: choice for q in question_ids for key, choice in pairs[q].items()}
    return JudgePart(state=state, questions=questions)


def _pair(
    question_id: QuestionId, subject: str, sections: list[str], candidates: list[Candidate]
) -> dict[str, Choice]:
    paths = [f"`drug_label.sections.{name}`" for name in sections]
    return {
        question_key(question_id, "stance"): Choice(
            instructions={
                "question": f"What does this drug label say about {subject}?",
                "read_only": paths,
                "rules": _READING_RULES,
            },
            criteria=_STANCE_CRITERIA,
        ),
        question_key(question_id, "evidence"): Choice(
            instructions={
                "question": f"Which sentence best shows what this drug label says about {subject}?",
                "read_only": paths,
                "options": (
                    "Each option is the id of one sentence in the listed sections. Choose "
                    f"`{NONE}` if no listed sentence addresses the subject."
                ),
                "rules": _READING_RULES,
            },
            criteria={c.id: None for c in candidates}
            | {NONE: f"No sentence in the listed sections addresses {subject}."},
        ),
    }


class Judge:
    def __init__(self, client: TypeSafeClient | None, model: str) -> None:
        self._client = client
        self._model = model

    @property
    def model(self) -> str:
        """The model as requested, which keys stored runs."""
        return self._model

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
        distributions: dict[str, Distribution] = {}
        model_versions: set[str] = set()
        input_tokens: list[int | None] = []
        output_tokens: list[int | None] = []
        for part in request.parts:
            try:
                response = self._client.system_one(
                    state=part.state, questions=part.questions, model=self._model
                )
            except TypeSafeError as exc:
                raise JudgeError("The Jev request failed.") from exc
            model_versions.add(response.model)
            input_tokens.append(response.usage.input_tokens)
            output_tokens.append(response.usage.output_tokens)
            for key, question in part.questions.items():
                distributions[key] = _distribution(key, question, response.answers.get(key))

        # Parts of one label must come from one model version, or the run mixes models.
        if len(model_versions) != 1:
            raise JudgeError(f"Jev answered one label with several models: {model_versions}.")
        return JudgeResult(
            model_version=model_versions.pop(),
            latency_ms=round((perf_counter() - started) * 1000),
            input_tokens=_total(input_tokens),
            output_tokens=_total(output_tokens),
            distributions=distributions,
        )


def _sections_state(groups: list[list[Candidate]]) -> dict[str, dict[str, Any]]:
    sections: dict[str, dict[str, Any]] = {}
    for candidates in groups:
        for c in candidates:
            entry = c.text if c.lead_in is None else {"lead_in": c.lead_in.text, "text": c.text}
            sections.setdefault(c.section, {})[c.id] = entry
    return sections


def _hash(parts: list[JudgePart]) -> str:
    bodies = [
        {
            "state": part.state,
            "questions": {k: q.model_dump(mode="json") for k, q in part.questions.items()},
        }
        for part in parts
    ]
    # A single part hashes exactly as unsplit requests always have, so runs stored before
    # splitting existed stay valid. No parts (every question skipped) hashes the empty list,
    # a fixed value, so such a label still has a well-defined prompt hash.
    body: object
    if not bodies:
        body = []
    elif len(bodies) == 1:
        body = bodies[0]
    else:
        body = bodies
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _total(counts: list[int | None]) -> int | None:
    return None if any(c is None for c in counts) else sum(c for c in counts if c is not None)


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
