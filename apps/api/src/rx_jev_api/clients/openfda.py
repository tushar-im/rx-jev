"""openFDA client: finds the one canonical label per product type for an ingredient set.

openFDA holds hundreds of labels per ingredient, one per repackager. The canonical rule:
1. The label's ingredient list matches the requested ingredients exactly (salts allowed).
2. Original packager preferred; repackagers only when no original packager label exists.
3. Latest `effective_time` wins.
Run separately for OTC and prescription labels.
"""

from datetime import date, datetime
from typing import Literal

import httpx
from pydantic import BaseModel, ValidationError, computed_field

from rx_jev_api.clients.errors import UpstreamError

__all__ = [
    "PAGE_SIZE",
    "CanonicalLabels",
    "Label",
    "ProductType",
    "OpenFdaClient",
    "UpstreamError",
    "matches_ingredients",
]

PAGE_SIZE = 5
MAX_PAGES = 4
DAILYMED_URL = "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid="

ProductType = Literal["otc", "prescription"]
_PRODUCT_TYPES: dict[ProductType, str] = {
    "otc": "HUMAN OTC DRUG",
    "prescription": "HUMAN PRESCRIPTION DRUG",
}
# Top-level label fields that are not label text.
_METADATA_FIELDS = {"id", "set_id", "version", "effective_time", "openfda"}


class Label(BaseModel):
    set_id: str
    version: str
    effective_time: date
    product_type: ProductType
    brand_name: str | None
    manufacturer_name: str | None
    substance_names: list[str]
    is_original_packager: bool
    # openFDA section field name -> verbatim text. HTML `*_table` fields are dropped.
    sections: dict[str, str]

    @computed_field
    @property
    def dailymed_url(self) -> str:
        return DAILYMED_URL + self.set_id


class CanonicalLabels(BaseModel):
    otc: Label | None
    prescription: Label | None


# Raw openFDA payloads.


class _OpenFdaMeta(BaseModel):
    product_type: list[str] = []
    substance_name: list[str] = []
    brand_name: list[str] = []
    manufacturer_name: list[str] = []
    is_original_packager: list[bool] = []


class _RawLabel(BaseModel, extra="allow"):
    set_id: str
    version: str
    effective_time: str
    openfda: _OpenFdaMeta


class _SearchResponse(BaseModel):
    results: list[_RawLabel] = []


def matches_ingredients(substances: list[str], ingredients: list[str]) -> bool:
    """True when each ingredient pairs with exactly one substance and none are left over.

    A substance matches an ingredient when it equals it or adds a salt, so
    "METFORMIN HYDROCHLORIDE" matches "metformin" but "IBUPROFENOL" does not match "ibuprofen".
    """
    if len(substances) != len(ingredients):
        return False
    remaining = [s.upper() for s in substances]
    for ingredient in (i.upper() for i in ingredients):
        match = next(
            (s for s in remaining if s == ingredient or s.startswith(ingredient + " ")), None
        )
        if match is None:
            return False
        remaining.remove(match)
    return True


class OpenFdaClient:
    def __init__(self, http: httpx.Client, api_key: str | None = None) -> None:
        self._http = http
        self._api_key = api_key

    def canonical_labels(self, ingredients: list[str]) -> CanonicalLabels:
        if not ingredients:
            raise ValueError("At least one ingredient is required")
        return CanonicalLabels(
            otc=self._canonical(ingredients, "otc"),
            prescription=self._canonical(ingredients, "prescription"),
        )

    def _canonical(self, ingredients: list[str], product_type: ProductType) -> Label | None:
        search = " AND ".join(f'openfda.substance_name:"{i}"' for i in ingredients)
        search += f' AND openfda.product_type:"{_PRODUCT_TYPES[product_type]}"'
        raw = self._first_match(search + " AND openfda.is_original_packager:true", ingredients)
        if raw is None:
            raw = self._first_match(search, ingredients)
        return _to_label(raw, product_type) if raw is not None else None

    def _first_match(self, search: str, ingredients: list[str]) -> _RawLabel | None:
        # Results come newest first, so the first exact match is the canonical label.
        for page in range(MAX_PAGES):
            results = self._search(search, skip=page * PAGE_SIZE)
            for raw in results:
                if matches_ingredients(raw.openfda.substance_name, ingredients):
                    return raw
            if len(results) < PAGE_SIZE:
                return None
        return None

    def _search(self, search: str, skip: int) -> list[_RawLabel]:
        params: dict[str, str | int] = {
            "search": search,
            "limit": PAGE_SIZE,
            "skip": skip,
            "sort": "effective_time:desc",
        }
        if self._api_key:
            params["api_key"] = self._api_key
        try:
            response = self._http.get("/drug/label.json", params=params)
            # openFDA answers a search with no results with 404.
            if response.status_code == 404:
                return []
            response.raise_for_status()
            return _SearchResponse.model_validate(response.json()).results
        except (httpx.HTTPError, ValueError, ValidationError) as exc:
            raise UpstreamError("openFDA label search failed") from exc


def _to_label(raw: _RawLabel, product_type: ProductType) -> Label:
    try:
        effective_time = datetime.strptime(raw.effective_time, "%Y%m%d").date()
    except ValueError as exc:
        raise UpstreamError(f"openFDA label {raw.set_id} has a bad effective_time") from exc

    sections: dict[str, str] = {}
    for name, value in (raw.model_extra or {}).items():
        if name in _METADATA_FIELDS or name.endswith("_table"):
            continue
        if isinstance(value, list) and all(isinstance(v, str) for v in value):
            sections[name] = "\n\n".join(value)

    meta = raw.openfda
    return Label(
        set_id=raw.set_id,
        version=raw.version,
        effective_time=effective_time,
        product_type=product_type,
        brand_name=meta.brand_name[0] if meta.brand_name else None,
        manufacturer_name=meta.manufacturer_name[0] if meta.manufacturer_name else None,
        substance_names=meta.substance_name,
        is_original_packager=bool(meta.is_original_packager and meta.is_original_packager[0]),
        sections=sections,
    )
