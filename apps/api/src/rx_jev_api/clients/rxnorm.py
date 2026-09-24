"""RxNorm client: turns a drug name typed by a person into its ingredients and RxCUI."""

import httpx
from pydantic import BaseModel, ValidationError

from rx_jev_api.clients.errors import UpstreamError

__all__ = ["Ingredient", "Resolution", "RxNormClient", "UpstreamError"]


class Ingredient(BaseModel):
    rxcui: str
    name: str


class Resolution(BaseModel):
    query: str
    matched_rxcui: str
    ingredients: list[Ingredient]
    # The ingredient-set concept labels are keyed on: the IN for single-ingredient drugs,
    # the MIN for combinations. None when RxNorm has no single matching MIN.
    rxcui: str | None


# Raw RxNorm payloads. Only the fields we read; everything else is ignored.


class _IdGroup(BaseModel):
    rxnormId: list[str] = []


class _LookupResponse(BaseModel):
    idGroup: _IdGroup


class _Concept(BaseModel):
    rxcui: str
    name: str
    tty: str


class _ConceptGroup(BaseModel):
    tty: str
    conceptProperties: list[_Concept] = []


class _RelatedGroup(BaseModel):
    conceptGroup: list[_ConceptGroup] = []


class _RelatedResponse(BaseModel):
    relatedGroup: _RelatedGroup


class _DisplayTerms(BaseModel):
    term: list[str]


class _DisplayNamesResponse(BaseModel):
    displayTermsList: _DisplayTerms


class RxNormClient:
    def __init__(self, http: httpx.Client) -> None:
        self._http = http

    def resolve(self, name: str) -> Resolution | None:
        query = name.strip()
        if not query:
            return None

        # search=2 enables approximate matching, so "advill" still finds Advil.
        lookup = self._get(_LookupResponse, "/rxcui.json", {"name": query, "search": 2})
        if not lookup.idGroup.rxnormId:
            return None
        matched = lookup.idGroup.rxnormId[0]

        ingredients, mins = self._related(matched)
        if not ingredients:
            return None

        return Resolution(
            query=query,
            matched_rxcui=matched,
            ingredients=ingredients,
            rxcui=_ingredient_set_rxcui(ingredients, mins),
        )

    def ingredients_of(self, rxcui: str) -> list[Ingredient]:
        """Ingredients of any RxNorm concept; empty when RxNorm does not know the RxCUI."""
        ingredients, _ = self._related(rxcui)
        return ingredients

    def display_names(self) -> list[str]:
        """Every name RxNorm offers for autocomplete, about 28K ingredients and brands."""
        return self._get(_DisplayNamesResponse, "/displaynames.json", {}).displayTermsList.term

    def _related(self, rxcui: str) -> tuple[list[Ingredient], list[_Concept]]:
        related = self._get(_RelatedResponse, f"/rxcui/{rxcui}/related.json", {"tty": "IN MIN"})
        by_tty = {g.tty: g.conceptProperties for g in related.relatedGroup.conceptGroup}
        ingredients = sorted(
            (Ingredient(rxcui=c.rxcui, name=c.name) for c in by_tty.get("IN", [])),
            key=lambda i: i.name,
        )
        return ingredients, by_tty.get("MIN", [])

    def _get[T: BaseModel](self, model: type[T], path: str, params: dict[str, str | int]) -> T:
        try:
            response = self._http.get(path, params=params)
            response.raise_for_status()
            return model.model_validate(response.json())
        except (httpx.HTTPError, ValueError, ValidationError) as exc:
            raise UpstreamError(f"RxNorm request failed: {path}") from exc


def _ingredient_set_rxcui(ingredients: list[Ingredient], mins: list[_Concept]) -> str | None:
    if len(ingredients) == 1:
        return ingredients[0].rxcui
    # Related MINs from a combination product are the combination itself; expect exactly one.
    return mins[0].rxcui if len(mins) == 1 else None
