import type { Ingredient, SourceTrace } from '@rx-jev/contract'
import type { Label, OpenFdaClient } from './clients/openfda.ts'
import type { RxNormClient } from './clients/rxnorm.ts'
import { ProblemError } from './problems.ts'

export type Lookup = {
  ingredients: Ingredient[]
  // Canonical labels, OTC first.
  labels: Label[]
  sources: SourceTrace
}

/** The drug's ingredients and its canonical labels. 404 when either is missing. */
export async function canonicalLabels(
  rxcui: string,
  rxnorm: RxNormClient,
  openfda: OpenFdaClient,
): Promise<Lookup> {
  let started = Date.now()
  const ingredients = await rxnorm.ingredientsOf(rxcui)
  const rxnormMs = Date.now() - started
  if (ingredients.length === 0) throw new ProblemError(404, `No drug found for RxCUI ${rxcui}.`)

  started = Date.now()
  const canonical = await openfda.canonicalLabels(ingredients.map((i) => i.name))
  const openfdaMs = Date.now() - started
  const labels = [canonical.otc, canonical.prescription].filter((l): l is Label => l !== null)
  if (labels.length === 0) {
    const names = ingredients.map((i) => i.name).join(' and ')
    throw new ProblemError(404, `No FDA label found for ${names}.`)
  }
  return {
    ingredients,
    labels,
    sources: {
      rxnorm_ms: rxnormMs,
      openfda_ms: openfdaMs,
      openfda_requests: canonical.requests,
      matches: canonical.matches,
    },
  }
}
