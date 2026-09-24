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
        : {
            type: 'about:blank',
            title: 'Error',
            status: response.status,
            detail: 'Unexpected error',
          },
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

export const STANCES = [
  'warns_against',
  'caution',
  'dose_change',
  'no_known_issue',
  'not_mentioned',
] as const
export const StanceSchema = z.enum(STANCES)
export type Stance = z.infer<typeof StanceSchema>

export const GROUPS = ['who', 'conditions', 'combinations', 'daily_life', 'serious'] as const
export const GroupSchema = z.enum(GROUPS)
export type Group = z.infer<typeof GroupSchema>

export const QuoteSchema = z.object({
  section: z.string(),
  // Verbatim label text. When `lead_in` is set, show it with the text, both verbatim.
  text: z.string(),
  lead_in: z.string().nullable(),
})
export type Quote = z.infer<typeof QuoteSchema>

export const AnswerSchema = z.object({
  question_id: z.string(),
  group: GroupSchema,
  title: z.string(),
  // `judged`, or why the question was not sent to Jev.
  status: z.enum(['judged', 'no_sections', 'too_long']),
  reviewed: z.boolean(),
  // The category may be shown only when this is true.
  confident: z.boolean(),
  stance: z
    .object({
      choice: StanceSchema,
      confidence: z.number(),
      probabilities: z.record(StanceSchema, z.number()),
    })
    .nullable(),
  evidence: z
    .object({
      choice: z.string(),
      confidence: z.number(),
      probability: z.number(),
      quote: QuoteSchema.nullable(),
    })
    .nullable(),
})
export type Answer = z.infer<typeof AnswerSchema>

export const LabelAnswersSchema = z.object({
  set_id: z.string(),
  version: z.string(),
  effective_time: z.iso.date(),
  product_type: z.enum(['otc', 'prescription']),
  brand_name: z.string().nullable(),
  manufacturer_name: z.string().nullable(),
  dailymed_url: z.url(),
  answers: z.array(AnswerSchema),
})
export type LabelAnswers = z.infer<typeof LabelAnswersSchema>

export const AnswersResponseSchema = z.object({
  rxcui: z.string(),
  ingredients: z.array(IngredientSchema),
  labels: z.array(LabelAnswersSchema),
})
export type AnswersResponse = z.infer<typeof AnswersResponseSchema>

export function fetchAnswers(rxcui: string, signal?: AbortSignal): Promise<AnswersResponse> {
  return getJson(`/api/labels/${encodeURIComponent(rxcui)}/answers`, AnswersResponseSchema, signal)
}
