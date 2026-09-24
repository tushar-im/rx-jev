"""What one label says about a reader's own question, asked live.

The question becomes part of the Jev instructions (`judge.build_custom_request`); the five
answer categories and the verbatim-quote rule stay the same as for catalog questions. Custom
answers are never stored and never reviewed, so every ask calls Jev.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from rx_jev_api.deps import JudgeDep, OpenFdaDep, RxNormDep, SettingsDep
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


class AskRequest(BaseModel):
    # Which of the drug's canonical labels to read.
    set_id: str = Field(min_length=1, max_length=64)
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


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
    rxnorm: RxNormDep,
    openfda: OpenFdaDep,
    judge: JudgeDep,
    settings: SettingsDep,
) -> AskResponse:
    _, labels = canonical_labels(rxcui, rxnorm, openfda)
    label = next((lb for lb in labels if lb.set_id == body.set_id), None)
    if label is None:
        raise HTTPException(
            status_code=404, detail=f"Label {body.set_id} is not a current label of this drug."
        )

    request = build_custom_request(label, body.question)
    skipped = request.skipped.get(CUSTOM)
    if skipped is not None:
        answer = CustomAnswer(
            question=body.question,
            status=skipped,
            confident=False,
            stance=None,
            evidence=None,
        )
        return AskResponse(rxcui=rxcui, label=label_info(label), model_version=None, answer=answer)

    result = judge.judge(request)
    stance = result.distributions[question_key(CUSTOM, "stance")]
    evidence = result.distributions[question_key(CUSTOM, "evidence")]
    answer = CustomAnswer(
        question=body.question,
        status="judged",
        confident=is_confident(stance, evidence, settings.display_min_confidence),
        stance=StanceView.model_validate(stance.model_dump()),
        evidence=evidence_view(request.asked[CUSTOM], evidence),
    )
    return AskResponse(
        rxcui=rxcui, label=label_info(label), model_version=result.model_version, answer=answer
    )
