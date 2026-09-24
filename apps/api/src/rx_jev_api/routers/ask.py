"""What one label says about a reader's own question, asked live.

The question becomes part of the Jev instructions (`judge.build_custom_request`); the five
answer categories and the verbatim-quote rule stay the same as for catalog questions. Custom
answers are never stored and never reviewed, so every ask calls Jev, which is why asks are
limited in length and rate per client.
"""

import math
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, StringConstraints

from rx_jev_api.deps import AskLimiterDep, JudgeDep, OpenFdaDep, RxNormDep, SettingsDep
from rx_jev_api.judge import CUSTOM, build_custom_request, question_key
from rx_jev_api.routers.answers import (
    AnswerStatus,
    EvidenceView,
    LabelInfo,
    StanceView,
    evidence_view,
    is_confident,
    label_info,
)
from rx_jev_api.routers.labels import RxCuiPath, canonical_labels

router = APIRouter(prefix="/api/labels", tags=["ask"])

# A question, not a document: long enough for a sentence, short enough to stay a topic.
MIN_QUESTION_CHARS = 3
MAX_QUESTION_CHARS = 200


class AskRequest(BaseModel):
    # Which of the drug's canonical labels to read.
    set_id: str = Field(min_length=1, max_length=64)
    question: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, min_length=MIN_QUESTION_CHARS, max_length=MAX_QUESTION_CHARS
        ),
    ]


class CustomAnswer(BaseModel):
    question: str
    status: AnswerStatus
    # Custom answers are never checked by a pharmacist.
    reviewed: Literal[False] = False
    # Same rule as catalog answers: both confidences at the threshold, and a quote.
    confident: bool
    stance: StanceView | None
    evidence: EvidenceView | None


class AskResponse(BaseModel):
    rxcui: str
    label: LabelInfo
    # None when the question was skipped, so Jev was never asked.
    model_version: str | None
    answer: CustomAnswer


@router.post("/{rxcui}/ask")
def ask(
    rxcui: RxCuiPath,
    body: AskRequest,
    request: Request,
    rxnorm: RxNormDep,
    openfda: OpenFdaDep,
    judge: JudgeDep,
    settings: SettingsDep,
    limiter: AskLimiterDep,
) -> AskResponse:
    # A spent limit is refused before any upstream call, but an ask is counted only once
    # its label is found, so a request that fails validation or finds no label costs nothing.
    client = request.client.host if request.client else "unknown"
    _refuse_if_waiting(limiter.wait(client))

    _, labels = canonical_labels(rxcui, rxnorm, openfda)
    label = next((lb for lb in labels if lb.set_id == body.set_id), None)
    if label is None:
        raise HTTPException(
            status_code=404, detail=f"Label {body.set_id} is not a current label of this drug."
        )
    _refuse_if_waiting(limiter.hit(client))

    judge_request = build_custom_request(label, body.question)
    skipped = judge_request.skipped.get(CUSTOM)
    if skipped is not None:
        answer = CustomAnswer(
            question=body.question,
            status=skipped,
            confident=False,
            stance=None,
            evidence=None,
        )
        return AskResponse(rxcui=rxcui, label=label_info(label), model_version=None, answer=answer)

    result = judge.judge(judge_request)
    stance = result.distributions[question_key(CUSTOM, "stance")]
    evidence = result.distributions[question_key(CUSTOM, "evidence")]
    answer = CustomAnswer(
        question=body.question,
        status="judged",
        confident=is_confident(stance, evidence, settings.display_min_confidence),
        stance=StanceView.model_validate(stance.model_dump()),
        evidence=evidence_view(judge_request.asked[CUSTOM], evidence),
    )
    return AskResponse(
        rxcui=rxcui, label=label_info(label), model_version=result.model_version, answer=answer
    )


def _refuse_if_waiting(wait: float | None) -> None:
    if wait is None:
        return
    seconds = max(1, math.ceil(wait))
    raise HTTPException(
        status_code=429,
        detail=f"Too many questions. Try again in {_duration(seconds)}.",
        headers={"Retry-After": str(seconds)},
    )


def _duration(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds} seconds" if seconds != 1 else "1 second"
    minutes = math.ceil(seconds / 60)
    if minutes < 60:
        return f"{minutes} minutes" if minutes != 1 else "1 minute"
    hours = math.ceil(minutes / 60)
    return f"{hours} hours" if hours != 1 else "1 hour"
