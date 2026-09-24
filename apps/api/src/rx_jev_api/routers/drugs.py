"""Drug search: name suggestions while typing, then the chosen name's RxCUI.

The RxCUI returned by `resolve` is the ingredient-set concept that `/api/labels/{rxcui}`
and its answers take.
"""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from rx_jev_api.clients.rxnorm import Ingredient
from rx_jev_api.deps import DrugNamesDep, RxNormDep
from rx_jev_api.suggest import suggest

router = APIRouter(prefix="/api/drugs", tags=["drugs"])

SUGGESTION_LIMIT = 10


class Suggestions(BaseModel):
    query: str
    # Names exactly as RxNorm spells them, including tall-man lettering like "metFORMIN".
    names: list[str]


class ResolvedDrug(BaseModel):
    query: str
    rxcui: str
    ingredients: list[Ingredient]


@router.get("/suggestions")
def read_suggestions(
    q: Annotated[str, Query(min_length=2, max_length=100)], names: DrugNamesDep
) -> Suggestions:
    return Suggestions(query=q, names=suggest(names, q, SUGGESTION_LIMIT))


@router.get("/resolve")
def resolve_drug(
    name: Annotated[str, Query(min_length=1, max_length=100)], rxnorm: RxNormDep
) -> ResolvedDrug:
    resolution = rxnorm.resolve(name)
    if resolution is None:
        raise HTTPException(status_code=404, detail=f"No drug found named {name!r}.")
    if resolution.rxcui is None:
        names = " and ".join(i.name for i in resolution.ingredients)
        raise HTTPException(
            status_code=404, detail=f"RxNorm has no single entry for {names} together."
        )
    return ResolvedDrug(
        query=resolution.query, rxcui=resolution.rxcui, ingredients=resolution.ingredients
    )
