import type { LabelMatch, ProductType } from '@rx-jev/contract'
import { z } from 'zod'
import { get, type Http, parseBody } from '../http.ts'
import { UpstreamError } from '../problems.ts'

// openFDA client: finds the one canonical label per product type for an ingredient set.
//
// openFDA holds hundreds of labels per ingredient, one per repackager. The canonical rule:
// 1. The label's ingredient list matches the requested ingredients exactly (salts allowed).
// 2. The label has an application number (NDA, ANDA, BLA or OTC monograph). Homeopathic
//    products named after a drug, such as "Citalopram 30C", have none and are not that drug.
// 3. Original packager preferred; repackagers only when no original packager label exists.
// 4. Latest `effective_time` wins.
// Run separately for OTC and prescription labels.

// The first page is small because the canonical label is usually near the top and
// prescription labels are large. Later pages grow so a long tail of combination products
// cannot hide an exact match, and paging runs until results are exhausted.
export const PAGE_SIZE = 5
const LATER_PAGE_SIZES = [25, 100] as const
// openFDA refuses skip values above this.
const MAX_SKIP = 25_000
const DAILYMED_URL = 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid='

const PRODUCT_TYPES: Record<ProductType, string> = {
  otc: 'HUMAN OTC DRUG',
  prescription: 'HUMAN PRESCRIPTION DRUG',
}
// Top-level label fields that are not label text.
const METADATA_FIELDS = new Set(['id', 'set_id', 'version', 'effective_time', 'openfda'])

export const LabelSchema = z.object({
  set_id: z.string(),
  version: z.string(),
  effective_time: z.iso.date(),
  product_type: z.enum(['otc', 'prescription']),
  brand_name: z.string().nullable(),
  manufacturer_name: z.string().nullable(),
  substance_names: z.array(z.string()),
  is_original_packager: z.boolean(),
  // openFDA section field name -> verbatim text. HTML `*_table` fields are dropped.
  sections: z.record(z.string(), z.string()),
})
export type Label = z.infer<typeof LabelSchema>

export function dailymedUrl(label: Label): string {
  return DAILYMED_URL + label.set_id
}

export type CanonicalLabels = {
  otc: Label | null
  prescription: Label | null
  // Per product type with a canonical label.
  matches: Partial<Record<ProductType, LabelMatch>>
  // openFDA searches made, empty ones included.
  requests: number
  // True when served from the lookup cache instead of openFDA.
  cached: boolean
}

// Raw openFDA payloads.

const OpenFdaMeta = z.object({
  product_type: z.array(z.string()).default([]),
  substance_name: z.array(z.string()).default([]),
  brand_name: z.array(z.string()).default([]),
  manufacturer_name: z.array(z.string()).default([]),
  is_original_packager: z.array(z.boolean()).default([]),
  application_number: z.array(z.string()).default([]),
})

const RawLabel = z.looseObject({
  set_id: z.string(),
  version: z.string(),
  effective_time: z.string(),
  openfda: OpenFdaMeta,
})
type RawLabel = z.infer<typeof RawLabel>

const SearchResponse = z.object({
  meta: z.object({ results: z.object({ total: z.number().int() }).nullish() }).nullish(),
  results: z.array(RawLabel).default([]),
})

export function* pageSizes(): Generator<number> {
  yield PAGE_SIZE
  yield* LATER_PAGE_SIZES
  while (true) yield LATER_PAGE_SIZES[LATER_PAGE_SIZES.length - 1] ?? PAGE_SIZE
}

/**
 * True when each ingredient pairs with exactly one substance and none are left over.
 *
 * A substance matches an ingredient when it equals it or adds a salt, so
 * "METFORMIN HYDROCHLORIDE" matches "metformin" but "IBUPROFENOL" does not match "ibuprofen".
 */
export function matchesIngredients(substances: string[], ingredients: string[]): boolean {
  if (substances.length !== ingredients.length) return false
  const remaining = substances.map((s) => s.toUpperCase())
  for (const ingredient of ingredients.map((i) => i.toUpperCase())) {
    const index = remaining.findIndex((s) => s === ingredient || s.startsWith(`${ingredient} `))
    if (index === -1) return false
    remaining.splice(index, 1)
  }
  return true
}

export class OpenFdaClient {
  readonly #http: Http
  readonly #apiKey: string | null

  constructor(http: Http, apiKey: string | null = null) {
    this.#http = http
    this.#apiKey = apiKey
  }

  async canonicalLabels(ingredients: string[]): Promise<CanonicalLabels> {
    if (ingredients.length === 0) throw new Error('At least one ingredient is required')
    const counter = { requests: 0 }
    const result: CanonicalLabels = {
      otc: null,
      prescription: null,
      matches: {},
      requests: 0,
      cached: false,
    }
    for (const productType of ['otc', 'prescription'] as const) {
      const found = await this.#canonical(ingredients, productType, counter)
      if (found !== null) {
        result[productType] = found.label
        result.matches[productType] = found.match
      }
    }
    result.requests = counter.requests
    return result
  }

  async #canonical(
    ingredients: string[],
    productType: ProductType,
    counter: { requests: number },
  ): Promise<{ label: Label; match: LabelMatch } | null> {
    let search = ingredients.map((i) => `openfda.substance_name:"${i}"`).join(' AND ')
    search += ` AND openfda.product_type:"${PRODUCT_TYPES[productType]}"`
    const attempts: [boolean, string][] = [
      [true, `${search} AND openfda.is_original_packager:true`],
      [false, search],
    ]
    for (const [originalPackager, query] of attempts) {
      const { raw, total } = await this.#firstMatch(query, ingredients, counter)
      if (raw !== null) {
        return {
          label: toLabel(raw, productType),
          match: { total, original_packager: originalPackager },
        }
      }
    }
    return null
  }

  /** The canonical label for `search`, if any, and how many labels the search matched. */
  async #firstMatch(
    search: string,
    ingredients: string[],
    counter: { requests: number },
  ): Promise<{ raw: RawLabel | null; total: number }> {
    // Results come newest first, so the first exact match is the canonical label.
    let skip = 0
    let total = 0
    for (const limit of pageSizes()) {
      if (skip > MAX_SKIP) {
        throw new UpstreamError('openFDA result set too large to search for a canonical label')
      }
      const page = await this.#search(search, skip, limit, counter)
      if (skip === 0) total = page.total
      for (const raw of page.results) {
        const meta = raw.openfda
        if (
          meta.application_number.length > 0 &&
          matchesIngredients(meta.substance_name, ingredients)
        ) {
          return { raw, total }
        }
      }
      if (page.results.length < limit) return { raw: null, total }
      skip += limit
    }
    return { raw: null, total }
  }

  /** One page of results, and the total openFDA reports for the search. */
  async #search(
    search: string,
    skip: number,
    limit: number,
    counter: { requests: number },
  ): Promise<{ results: RawLabel[]; total: number }> {
    const params: Record<string, string | number> = {
      search,
      limit,
      skip,
      sort: 'effective_time:desc',
    }
    if (this.#apiKey) params.api_key = this.#apiKey
    counter.requests += 1
    const what = 'openFDA label search failed'
    const response = await get(this.#http, '/drug/label.json', params, what)
    // openFDA answers a search with no results with 404.
    if (response.status === 404) return { results: [], total: 0 }
    const body = await parseBody(response, SearchResponse, what)
    // A response without meta still counts what it returned.
    return { results: body.results, total: body.meta?.results?.total ?? body.results.length }
  }
}

function toLabel(raw: RawLabel, productType: ProductType): Label {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.effective_time)
  const effectiveTime = match ? `${match[1]}-${match[2]}-${match[3]}` : ''
  if (!z.iso.date().safeParse(effectiveTime).success) {
    throw new UpstreamError(`openFDA label ${raw.set_id} has a bad effective_time`)
  }

  const sections: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (METADATA_FIELDS.has(name) || name.endsWith('_table')) continue
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      sections[name] = value.join('\n\n')
    }
  }

  const meta = raw.openfda
  return {
    set_id: raw.set_id,
    version: raw.version,
    effective_time: effectiveTime,
    product_type: productType,
    brand_name: meta.brand_name[0] ?? null,
    manufacturer_name: meta.manufacturer_name[0] ?? null,
    substance_names: meta.substance_name,
    is_original_packager: meta.is_original_packager[0] ?? false,
    sections,
  }
}
