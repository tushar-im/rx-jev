"""What each canonical label says about every catalog question, served from the store.

A store miss judges every standard question for that label version in one Jev request and
stores the result before serving it. All misses are judged before any is stored, so a Jev
failure returns 503 and stores nothing. Answers are never partial or guessed.

The response carries raw judgments: the stance and evidence choices with their confidence.
Display thresholds come from the Gate 1 pharmacist review and are applied at read time.
"""

from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from rx_jev_api.catalog import CATALOG, Group, LabelFormat, Question, QuestionId, label_format
from rx_jev_api.clients.openfda import Label, ProductType
from rx_jev_api.clients.rxnorm import Ingredient
from rx_jev_api.deps import JudgeDep, OpenFdaDep, RxNormDep, StoreDep
from rx_jev_api.judge import (
    NONE,
    Distribution,
    JudgeRequest,
    Stance,
    build_request,
    question_key,
)
from rx_jev_api.routers.labels import RxCuiPath, canonical_labels
from rx_jev_api.sentences import Candidate
from rx_jev_api.store import StoredRun

router = APIRouter(prefix="/api/labels", tags=["answers"])

# `judged`, or why the question was not sent to Jev.
AnswerStatus = Literal["judged", "no_sections", "too_many_candidates"]


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
) -> AnswersResponse:
    ingredients, labels = canonical_labels(rxcui, rxnorm, openfda)
    requests = [build_request(label) for label in labels]
    runs = [
        store.find(label, request.prompt_hash, judge.model)
        for label, request in zip(labels, requests, strict=True)
    ]

    # Judge every miss before storing any, so a Jev failure stores nothing.
    results = {
        i: judge.judge(requests[i])
        for i, run in enumerate(runs)
        if run is None and requests[i].questions
    }
    for i, result in results.items():
        runs[i] = store.save(labels[i], requests[i], judge.model, result)

    return AnswersResponse(
        rxcui=rxcui,
        ingredients=ingredients,
        labels=[
            _label_answers(label, request, run)
            for label, request, run in zip(labels, requests, runs, strict=True)
        ],
    )


def _label_answers(label: Label, request: JudgeRequest, run: StoredRun | None) -> LabelAnswers:
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
        answers=[_answer(q, request, run) for q in CATALOG],
    )


def _answer(question: Question, request: JudgeRequest, run: StoredRun | None) -> Answer:
    skipped = request.skipped.get(question.id)
    if skipped is not None:
        return Answer(
            question_id=question.id,
            group=question.group,
            title=question.title,
            status=skipped,
            reviewed=False,
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
