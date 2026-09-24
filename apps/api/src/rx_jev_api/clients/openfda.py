"""openFDA client: finds the one canonical label per product type for an ingredient set.

openFDA holds hundreds of labels per ingredient, one per repackager. The canonical rule:
1. The label's ingredient list matches the requested ingredients exactly (salts allowed).
2. The label has an application number (NDA, ANDA, BLA or OTC monograph). Homeopathic
   products named after a drug, such as "Citalopram 30C", have none and are not that drug.
3. Original packager preferred; repackagers only when no original packager label exists.
4. Latest `effective_time` wins.
Run separately for OTC and prescription labels.
"""

from collections.abc import Iterator
from datetime import date, datetime
from typing import Literal

import httpx
from pydantic import BaseModel, ValidationError, computed_field

from rx_jev_api.clients.errors import UpstreamError

__all__ = [
    "PAGE_SIZE",
    "CanonicalLabels",
    "Label",
    "LabelMatch",
    "ProductType",
    "OpenFdaClient",
    "UpstreamError",
    "matches_ingredients",
    "page_sizes",
]

# The first page is small because the canonical label is usually near the top and
# prescription labels are large. Later pages grow so a long tail of combination products
# cannot hide an exact match, and paging runs until results are exhausted.
PAGE_SIZE = 5
_LATER_PAGE_SIZES = (25, 100)
# openFDA refuses skip values above this.
_MAX_SKIP = 25_000
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


class LabelMatch(BaseModel, frozen=True):
    # Labels openFDA matched in the search the canonical label was picked from.
    total: int
    # True when that search was limited to original packagers, the first choice.
    original_packager: bool


class CanonicalLabels(BaseModel):
    otc: Label | None
    prescription: Label | None
    # Per product type with a canonical label.
    matches: dict[ProductType, LabelMatch] = {}
    # openFDA searches made, empty ones included.
    requests: int = 0


# Raw openFDA payloads.


class _OpenFdaMeta(BaseModel):
    product_type: list[str] = []
    substance_name: list[str] = []
    brand_name: list[str] = []
    manufacturer_name: list[str] = []
    is_original_packager: list[bool] = []
    application_number: list[str] = []


class _RawLabel(BaseModel, extra="allow"):
    set_id: str
    version: str
    effective_time: str
    openfda: _OpenFdaMeta


class _ResultCounts(BaseModel):
    total: int


class _SearchMeta(BaseModel):
    results: _ResultCounts | None = None


class _SearchResponse(BaseModel):
    meta: _SearchMeta | None = None
    results: list[_RawLabel] = []


def page_sizes() -> Iterator[int]:
    yield PAGE_SIZE
    yield from _LATER_PAGE_SIZES
    while True:
        yield _LATER_PAGE_SIZES[-1]


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
        self._requests = 0

    def canonical_labels(self, ingredients: list[str]) -> CanonicalLabels:
        if not ingredients:
            raise ValueError("At least one ingredient is required")
        self._requests = 0
        labels: dict[ProductType, Label | None] = {}
        matches: dict[ProductType, LabelMatch] = {}
        for product_type in _PRODUCT_TYPES:
            label, match = self._canonical(ingredients, product_type)
            labels[product_type] = label
            if match is not None:
                matches[product_type] = match
        return CanonicalLabels(
            otc=labels["otc"],
            prescription=labels["prescription"],
            matches=matches,
            requests=self._requests,
        )

    def _canonical(
        self, ingredients: list[str], product_type: ProductType
    ) -> tuple[Label | None, LabelMatch | None]:
        search = " AND ".join(f'openfda.substance_name:"{i}"' for i in ingredients)
        search += f' AND openfda.product_type:"{_PRODUCT_TYPES[product_type]}"'
        for original_packager, query in (
            (True, search + " AND openfda.is_original_packager:true"),
            (False, search),
        ):
            raw, total = self._first_match(query, ingredients)
            if raw is not None:
                match = LabelMatch(total=total, original_packager=original_packager)
                return _to_label(raw, product_type), match
        return None, None

    def _first_match(self, search: str, ingredients: list[str]) -> tuple[_RawLabel | None, int]:
        """The canonical label for `search`, if any, and how many labels the search matched."""
        # Results come newest first, so the first exact match is the canonical label.
        skip = 0
        total = 0
        for limit in page_sizes():
            if skip > _MAX_SKIP:
                raise UpstreamError("openFDA result set too large to search for a canonical label")
            results, page_total = self._search(search, skip=skip, limit=limit)
            if skip == 0:
                total = page_total
            for raw in results:
                if raw.openfda.application_number and matches_ingredients(
                    raw.openfda.substance_name, ingredients
                ):
                    return raw, total
            if len(results) < limit:
                return None, total
            skip += limit
        return None, total

    def _search(self, search: str, skip: int, limit: int) -> tuple[list[_RawLabel], int]:
        """One page of results, and the total openFDA reports for the search."""
        params: dict[str, str | int] = {
            "search": search,
            "limit": limit,
            "skip": skip,
            "sort": "effective_time:desc",
        }
        if self._api_key:
            params["api_key"] = self._api_key
        self._requests += 1
        try:
            response = self._http.get("/drug/label.json", params=params)
            # openFDA answers a search with no results with 404.
            if response.status_code == 404:
                return [], 0
            response.raise_for_status()
            body = _SearchResponse.model_validate(response.json())
            counts = body.meta.results if body.meta else None
            # A response without meta still counts what it returned.
            return body.results, counts.total if counts else len(body.results)
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
