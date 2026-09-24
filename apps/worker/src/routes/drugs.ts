import type { ResolvedDrug, Suggestions } from '@rx-jev/contract'
import { suggest } from '@rx-jev/contract/suggest'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app.ts'
import { ProblemError, parseOr422 } from '../problems.ts'

// Drug search: name suggestions while typing, then the chosen name's RxCUI. The RxCUI
// returned by `resolve` is the ingredient-set concept the labels and answers routes take.

// Lengths count characters, as the Python API did.
function chars(min: number, max: number): z.ZodString {
  return z
    .string()
    .refine((s) => [...s].length >= min && [...s].length <= max, `${min} to ${max} characters`)
}

const SuggestionsQuery = z.object({ q: chars(2, 100) })
const ResolveQuery = z.object({ name: chars(1, 100) })

export const drugRoutes = new Hono<AppEnv>()
  .get('/suggestions', async (c) => {
    const { q } = parseOr422(SuggestionsQuery, c.req.query(), 'query')
    const names = await c.var.services.drugNames()
    return c.json<Suggestions>({ query: q, names: suggest(names, q) })
  })
  .get('/resolve', async (c) => {
    const { name } = parseOr422(ResolveQuery, c.req.query(), 'query')
    const resolution = await c.var.services.rxnorm.resolve(name)
    if (resolution === null) {
      throw new ProblemError(404, `No drug found named ${pythonRepr(name)}.`)
    }
    if (resolution.rxcui === null) {
      const names = resolution.ingredients.map((i) => i.name).join(' and ')
      throw new ProblemError(404, `RxNorm has no single entry for ${names} together.`)
    }
    return c.json<ResolvedDrug>({
      query: resolution.query,
      rxcui: resolution.rxcui,
      ingredients: resolution.ingredients,
    })
  })

// The detail quoted the name as Python's repr did: single quotes unless the name has one.
function pythonRepr(text: string): string {
  if (text.includes("'") && !text.includes('"')) return `"${text}"`
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
