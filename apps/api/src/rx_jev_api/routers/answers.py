"""What each canonical label says about every catalog question, served from the store.

A store miss judges every standard question for that label version in one Jev request and
stores the result before serving it (see `answering.judge_labels`). A Jev failure returns
503 and stores nothing. Answers are never partial or guessed.

The response carries raw judgments: the stance and evidence choices with their confidence.
The display threshold agreed at Gate 1 is applied at read time as `confident`, so it can
change without re-running inference.
"""

from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from rx_jev_api.answering import JudgedLabel, judge_labels
from rx_jev_api.catalog import CATALOG, Group, LabelFormat, Question, QuestionId, label_format
from rx_jev_api.clients.openfda import ProductType
from rx_jev_api.clients.rxnorm import Ingredient
from rx_jev_api.config import GATE_1_MIN_CONFIDENCE
from rx_jev_api.deps import JudgeDep, OpenFdaDep, RxNormDep, SettingsDep, StoreDep
from rx_jev_api.judge import (
    NONE,
    Distribution,
    JudgeRequest,
    SkipReason,
    Stance,
    question_key,
)
from rx_jev_api.routers.labels import RxCuiPath, canonical_labels
from rx_jev_api.sentences import Candidate
from rx_jev_api.store import StoredRun

router = APIRouter(prefix="/api/labels", tags=["answers"])

# `judged`, or why the question was not sent to Jev.
AnswerStatus = Literal["judged", SkipReason]


class Quote(BaseModel):
    section: str
    # Verbatim label text. When `lead_in` is set, show it with the text, both verbatim.
    text: str
    lead_in: str | None


class StanceView(BaseModel):
    choice: Stance
    confidence: float
    probabilities: dict[Stance, float]


class EvidenceView(BaseModel):
    # A candidate sentence ID, or `none`.
    choice: str
    confidence: float
    probability: float
    quote: Quote | None


class Answer(BaseModel):
    question_id: QuestionId
    group: Group
    title: str
    status: AnswerStatus
    # True only once a pharmacist has checked both judgments.
    reviewed: bool
    # True when both confidences reach the display threshold and there is a quote, so the
    # category may be shown. Otherwise the UI shows "We couldn't find a clear answer" and
    # points to the full label. Always False when skipped or when evidence is `none`.
    confident: bool
    stance: StanceView | None
    evidence: EvidenceView | None


class LabelAnswers(BaseModel):
    set_id: str
    version: str
    effective_time: date
    product_type: ProductType
    layout: LabelFormat
    brand_name: str | None
    manufacturer_name: str | None
    dailymed_url: str
    # None when no question had candidate sections, so Jev was never asked.
    model_version: str | None
    judged_at: datetime | None
    answers: list[Answer]


class AnswersResponse(BaseModel):
    rxcui: str
    ingredients: list[Ingredient]
    labels: list[LabelAnswers]


@router.get("/{rxcui}/answers")
def read_answers(
    rxcui: RxCuiPath,
    rxnorm: RxNormDep,
    openfda: OpenFdaDep,
    judge: JudgeDep,
    store: StoreDep,
    settings: SettingsDep,
) -> AnswersResponse:
    ingredients, labels = canonical_labels(rxcui, rxnorm, openfda)
    judged = judge_labels(labels, judge, store)
    return AnswersResponse(
        rxcui=rxcui,
        ingredients=ingredients,
        labels=[label_answers(j, settings.display_min_confidence) for j in judged],
    )


def label_answers(
    judged: JudgedLabel, min_confidence: float = GATE_1_MIN_CONFIDENCE
) -> LabelAnswers:
    label, request, run = judged.label, judged.request, judged.run
    return LabelAnswers(
        set_id=label.set_id,
        version=label.version,
        effective_time=label.effective_time,
        product_type=label.product_type,
        layout=label_format(label),
        brand_name=label.brand_name,
        manufacturer_name=label.manufacturer_name,
        dailymed_url=label.dailymed_url,
        model_version=run.model_version if run else None,
        judged_at=run.created_at if run else None,
        answers=[_answer(q, request, run, min_confidence) for q in CATALOG],
    )


def _answer(
    question: Question, request: JudgeRequest, run: StoredRun | None, min_confidence: float
) -> Answer:
    skipped = request.skipped.get(question.id)
    if skipped is not None:
        return Answer(
            question_id=question.id,
            group=question.group,
            title=question.title,
            status=skipped,
            reviewed=False,
            confident=False,
            stance=None,
            evidence=None,
        )
    if run is None:
        raise RuntimeError(f"No stored run for judged question {question.id}.")

    stance = run.judgments[question_key(question.id, "stance")]
    evidence = run.judgments[question_key(question.id, "evidence")]
    return Answer(
        question_id=question.id,
        group=question.group,
        title=question.title,
        status="judged",
        reviewed=stance.reviewed and evidence.reviewed,
        confident=evidence.distribution.choice != NONE
        and min(stance.distribution.confidence, evidence.distribution.confidence) >= min_confidence,
        stance=StanceView.model_validate(stance.distribution.model_dump()),
        evidence=_evidence(request.asked[question.id], evidence.distribution),
    )


def _evidence(candidates: list[Candidate], distribution: Distribution) -> EvidenceView:
    chosen = distribution.choice
    candidate = next((c for c in candidates if c.id == chosen), None)
    if candidate is None and chosen != NONE:
        raise RuntimeError(f"Stored evidence {chosen} is not a candidate of this label version.")
    quote = (
        Quote(
            section=candidate.section,
            text=candidate.text,
            lead_in=candidate.lead_in.text if candidate.lead_in else None,
        )
        if candidate
        else None
    )
    return EvidenceView(
        choice=chosen,
        confidence=distribution.confidence,
        probability=distribution.probabilities[chosen],
        quote=quote,
    )
