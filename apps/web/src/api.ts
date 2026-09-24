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
  return requestJson(path, schema, { headers: { Accept: 'application/json' }, signal })
}

async function postJson<T>(
  path: string,
  payload: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  return requestJson(path, schema, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
}

async function requestJson<T>(path: string, schema: z.ZodType<T>, init: RequestInit): Promise<T> {
  const response = await fetch(path, init)
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

// What Jev judged about one question, catalog or custom.
const judged = {
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
  // How many candidate sentences Jev chose from, and their sections. 0 and [] when skipped.
  candidates: z.number().int(),
  sections: z.array(z.string()),
}

export const AnswerSchema = z.object({
  question_id: z.string(),
  group: GroupSchema,
  title: z.string(),
  ...judged,
})
export type Answer = z.infer<typeof AnswerSchema>

// A reader's own question, asked live. Never stored, so never checked by a pharmacist.
export const CustomAnswerSchema = z.object({
  question: z.string(),
  ...judged,
  reviewed: z.literal(false),
})
export type CustomAnswer = z.infer<typeof CustomAnswerSchema>

export const LabelInfoSchema = z.object({
  set_id: z.string(),
  version: z.string(),
  effective_time: z.iso.date(),
  product_type: z.enum(['otc', 'prescription']),
  brand_name: z.string().nullable(),
  manufacturer_name: z.string().nullable(),
  dailymed_url: z.url(),
})
export type LabelInfo = z.infer<typeof LabelInfoSchema>

// The Jev run behind a label's answers, or behind one custom question.
const run = {
  model_version: z.string().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  latency_ms: z.number().int().nullable(),
}

export const LabelAnswersSchema = LabelInfoSchema.extend({
  ...run,
  // Stored times are UTC. One without a timezone is read as UTC, never as the viewer's local
  // time, which could show the wrong day.
  judged_at: z.iso
    .datetime({ offset: true, local: true })
    .transform((t) => (/(Z|[+-]\d{2}:\d{2})$/.test(t) ? t : `${t}Z`))
    .nullable(),
  // True when this request judged the label; false when it came from the store.
  fresh: z.boolean(),
  answers: z.array(AnswerSchema),
})
export type LabelAnswers = z.infer<typeof LabelAnswersSchema>

export const PRODUCT_TYPES = ['otc', 'prescription'] as const
export const ProductTypeSchema = z.enum(PRODUCT_TYPES)

// What the lookup asked RxNorm and openFDA.
export const SourceTraceSchema = z.object({
  rxnorm_ms: z.number().int(),
  openfda_ms: z.number().int(),
  openfda_requests: z.number().int(),
  // Per product type with a canonical label: how many labels its search matched.
  matches: z.partialRecord(
    ProductTypeSchema,
    z.object({ total: z.number().int(), original_packager: z.boolean() }),
  ),
})
export type SourceTrace = z.infer<typeof SourceTraceSchema>

export const AnswersResponseSchema = z.object({
  rxcui: z.string(),
  ingredients: z.array(IngredientSchema),
  labels: z.array(LabelAnswersSchema),
  sources: SourceTraceSchema,
})
export type AnswersResponse = z.infer<typeof AnswersResponseSchema>

export function fetchAnswers(rxcui: string, signal?: AbortSignal): Promise<AnswersResponse> {
  return getJson(`/api/labels/${encodeURIComponent(rxcui)}/answers`, AnswersResponseSchema, signal)
}

export const AskResponseSchema = z.object({
  rxcui: z.string(),
  label: LabelInfoSchema,
  ...run,
  answer: CustomAnswerSchema,
  sources: SourceTraceSchema,
})
export type AskResponse = z.infer<typeof AskResponseSchema>

export function askLabel(
  rxcui: string,
  setId: string,
  question: string,
  signal?: AbortSignal,
): Promise<AskResponse> {
  return postJson(
    `/api/labels/${encodeURIComponent(rxcui)}/ask`,
    { set_id: setId, question },
    AskResponseSchema,
    signal,
  )
}
