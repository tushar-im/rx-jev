from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path
from pydantic import BaseModel

from rx_jev_api.catalog import (
    CATALOG,
    Group,
    LabelFormat,
    QuestionId,
    candidate_sections,
    label_format,
)
from rx_jev_api.clients.openfda import Label, ProductType
from rx_jev_api.clients.rxnorm import Ingredient
from rx_jev_api.deps import OpenFdaDep, RxNormDep
from rx_jev_api.sentences import split_section

router = APIRouter(prefix="/api/labels", tags=["labels"])


class CandidateView(BaseModel):
    id: str
    text: str
    # Verbatim governing text for a bullet item. Show it with the candidate, never drop it.
    lead_in: str | None


class QuestionSections(BaseModel):
    id: QuestionId
    group: Group
    title: str
    # Label sections that may answer this question, in priority order. Empty means the
    # label layout has no section for it, such as a boxed warning on an OTC label.
    sections: list[str]


class LabelView(BaseModel):
    set_id: str
    version: str
    effective_time: date
    product_type: ProductType
    layout: LabelFormat
    brand_name: str | None
    manufacturer_name: str | None
    dailymed_url: str
    questions: list[QuestionSections]
    sections: dict[str, list[CandidateView]]


class LabelsResponse(BaseModel):
    rxcui: str
    ingredients: list[Ingredient]
    labels: list[LabelView]


@router.get("/{rxcui}")
def read_labels(
    rxcui: Annotated[str, Path(pattern=r"^\d{1,12}$", description="RxNorm concept ID")],
    rxnorm: RxNormDep,
    openfda: OpenFdaDep,
) -> LabelsResponse:
    ingredients = rxnorm.ingredients_of(rxcui)
    if not ingredients:
        raise HTTPException(status_code=404, detail=f"No drug found for RxCUI {rxcui}.")

    canonical = openfda.canonical_labels([i.name for i in ingredients])
    labels = [label for label in (canonical.otc, canonical.prescription) if label is not None]
    if not labels:
        names = " and ".join(i.name for i in ingredients)
        raise HTTPException(status_code=404, detail=f"No FDA label found for {names}.")

    return LabelsResponse(
        rxcui=rxcui, ingredients=ingredients, labels=[_view(label) for label in labels]
    )


def _view(label: Label) -> LabelView:
    questions = [
        QuestionSections(
            id=q.id, group=q.group, title=q.title, sections=candidate_sections(q.id, label)
        )
        for q in CATALOG
    ]
    referenced = dict.fromkeys(name for q in questions for name in q.sections)
    return LabelView(
        set_id=label.set_id,
        version=label.version,
        effective_time=label.effective_time,
        product_type=label.product_type,
        layout=label_format(label),
        brand_name=label.brand_name,
        manufacturer_name=label.manufacturer_name,
        dailymed_url=label.dailymed_url,
        questions=questions,
        sections={
            name: [
                CandidateView(id=c.id, text=c.text, lead_in=c.lead_in.text if c.lead_in else None)
                for c in split_section(name, label.sections[name])
            ]
            for name in referenced
        },
    )
