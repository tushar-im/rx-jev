import type { Ingredient } from '@rx-jev/contract'
import { z } from 'zod'
import { get, type Http, parseBody } from '../http.ts'
import { compareCodePoints } from '../python.ts'

// RxNorm client: turns a drug name typed by a person into its ingredients and RxCUI.

export type Resolution = {
  query: string
  matched_rxcui: string
  ingredients: Ingredient[]
  // The ingredient-set concept labels are keyed on: the IN for single-ingredient drugs, the
  // MIN for combinations. Null when RxNorm has no single matching MIN.
  rxcui: string | null
}

// Raw RxNorm payloads. Only the fields we read; everything else is ignored.

const LookupResponse = z.object({
  idGroup: z.object({ rxnormId: z.array(z.string()).default([]) }),
})

const Concept = z.object({ rxcui: z.string(), name: z.string(), tty: z.string() })
type Concept = z.infer<typeof Concept>

const RelatedResponse = z.object({
  relatedGroup: z.object({
    conceptGroup: z
      .array(z.object({ tty: z.string(), conceptProperties: z.array(Concept).default([]) }))
      .default([]),
  }),
})

const DisplayNamesResponse = z.object({
  displayTermsList: z.object({ term: z.array(z.string()) }),
})

export class RxNormClient {
  readonly #http: Http

  constructor(http: Http) {
    this.#http = http
  }

  async resolve(name: string): Promise<Resolution | null> {
    const query = name.trim()
    if (!query) return null

    // search=2 enables approximate matching, so "advill" still finds Advil.
    const lookup = await this.#get(LookupResponse, '/rxcui.json', { name: query, search: 2 })
    const matched = lookup.idGroup.rxnormId[0]
    if (matched === undefined) return null

    const { ingredients, mins } = await this.#related(matched)
    if (ingredients.length === 0) return null

    return {
      query,
      matched_rxcui: matched,
      ingredients,
      rxcui: ingredientSetRxcui(ingredients, mins),
    }
  }

  /** Ingredients of any RxNorm concept; empty when RxNorm does not know the RxCUI. */
  async ingredientsOf(rxcui: string): Promise<Ingredient[]> {
    return (await this.#related(rxcui)).ingredients
  }

  /** Every name RxNorm offers for autocomplete, about 28K ingredients and brands. */
  async displayNames(): Promise<string[]> {
    const body = await this.#get(DisplayNamesResponse, '/displaynames.json', {})
    return body.displayTermsList.term
  }

  async #related(rxcui: string): Promise<{ ingredients: Ingredient[]; mins: Concept[] }> {
    const related = await this.#get(RelatedResponse, `/rxcui/${rxcui}/related.json`, {
      tty: 'IN MIN',
    })
    const byTty = new Map(
      related.relatedGroup.conceptGroup.map((g) => [g.tty, g.conceptProperties]),
    )
    const ingredients = (byTty.get('IN') ?? [])
      .map((c) => ({ rxcui: c.rxcui, name: c.name }))
      .sort((a, b) => compareCodePoints(a.name, b.name))
    return { ingredients, mins: byTty.get('MIN') ?? [] }
  }

  async #get<S extends z.ZodType>(
    schema: S,
    path: string,
    params: Record<string, string | number>,
  ): Promise<z.infer<S>> {
    const what = `RxNorm request failed: ${path}`
    return parseBody(await get(this.#http, path, params, what), schema, what)
  }
}

function ingredientSetRxcui(ingredients: Ingredient[], mins: Concept[]): string | null {
  if (ingredients.length === 1) return ingredients[0]?.rxcui ?? null
  // Related MINs from a combination product are the combination itself; expect exactly one.
  return mins.length === 1 ? (mins[0]?.rxcui ?? null) : null
}
