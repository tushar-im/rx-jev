import { z } from 'zod'

// Every response from the backend is parsed with zod before the UI touches it.

export const HealthSchema = z.object({ status: z.literal('ok') })
export type Health = z.infer<typeof HealthSchema>

export const IngredientSchema = z.object({ rxcui: z.string(), name: z.string() })
export type Ingredient = z.infer<typeof IngredientSchema>

// Names exactly as RxNorm spells them, including tall-man lettering like "metFORMIN".
export const SuggestionsSchema = z.object({ query: z.string(), names: z.array(z.string()) })
export type Suggestions = z.infer<typeof SuggestionsSchema>

// `rxcui` is the ingredient-set concept that the labels and answers routes take.
export const ResolvedDrugSchema = z.object({
  query: z.string(),
  rxcui: z.string(),
  ingredients: z.array(IngredientSchema),
})
export type ResolvedDrug = z.infer<typeof ResolvedDrugSchema>

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
})
export type Problem = z.infer<typeof ProblemSchema>

export class ApiError extends Error {
  readonly problem: Problem

  constructor(problem: Problem) {
    super(problem.detail)
    this.problem = problem
  }
}

async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal })
  const body: unknown = await response.json()
  if (!response.ok) {
    const problem = ProblemSchema.safeParse(body)
    throw new ApiError(
      problem.success
        ? problem.data
        : { type: 'about:blank', title: 'Error', status: response.status, detail: 'Unexpected error' },
    )
  }
  return schema.parse(body)
}

export function fetchHealth(): Promise<Health> {
  return getJson('/api/health', HealthSchema)
}

export function fetchSuggestions(query: string, signal?: AbortSignal): Promise<Suggestions> {
  const params = new URLSearchParams({ q: query })
  return getJson(`/api/drugs/suggestions?${params}`, SuggestionsSchema, signal)
}

export function resolveDrug(name: string): Promise<ResolvedDrug> {
  const params = new URLSearchParams({ name })
  return getJson(`/api/drugs/resolve?${params}`, ResolvedDrugSchema)
}
