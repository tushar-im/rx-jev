import { z } from 'zod'

// The API contract: every request and response the API Worker serves, as zod schemas. The
// Worker builds its responses to these types and the web app parses every response with
// them, so the two can never drift apart.

export const HealthSchema = z.object({ status: z.literal('ok') })
export type Health = z.infer<typeof HealthSchema>

// RFC 7807 Problem Details, the body of every error response.
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
})
export type Problem = z.infer<typeof ProblemSchema>

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

export const PRODUCT_TYPES = ['otc', 'prescription'] as const
export const ProductTypeSchema = z.enum(PRODUCT_TYPES)
export type ProductType = z.infer<typeof ProductTypeSchema>

// The layout a label is read as, which can differ from its product type.
export const LayoutSchema = z.enum(['otc', 'prescription'])
export type Layout = z.infer<typeof LayoutSchema>

// Why a question was not sent to Jev.
export const SKIP_REASONS = ['no_sections', 'too_long'] as const
export const SkipReasonSchema = z.enum(SKIP_REASONS)
export type SkipReason = z.infer<typeof SkipReasonSchema>

export const QuoteSchema = z.object({
  section: z.string(),
  // Verbatim label text. When `lead_in` is set, show it with the text, both verbatim.
  text: z.string(),
  lead_in: z.string().nullable(),
})
export type Quote = z.infer<typeof QuoteSchema>

export const StanceViewSchema = z.object({
  choice: StanceSchema,
  confidence: z.number(),
  probabilities: z.record(StanceSchema, z.number()),
})
export type StanceView = z.infer<typeof StanceViewSchema>

export const EvidenceViewSchema = z.object({
  // A candidate sentence ID, or `none`.
  choice: z.string(),
  confidence: z.number(),
  probability: z.number(),
  quote: QuoteSchema.nullable(),
})
export type EvidenceView = z.infer<typeof EvidenceViewSchema>

// What Jev judged about one question, catalog or custom.
const judged = {
  // `judged`, or why the question was not sent to Jev.
  status: z.enum(['judged', ...SKIP_REASONS]),
  reviewed: z.boolean(),
  // The category may be shown only when this is true.
  confident: z.boolean(),
  stance: StanceViewSchema.nullable(),
  evidence: EvidenceViewSchema.nullable(),
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
  product_type: ProductTypeSchema,
  layout: LayoutSchema,
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

export const LabelMatchSchema = z.object({
  // Labels openFDA matched in the search the canonical label was picked from.
  total: z.number().int(),
  // True when that search was limited to original packagers, the first choice.
  original_packager: z.boolean(),
})
export type LabelMatch = z.infer<typeof LabelMatchSchema>

// What the lookup asked RxNorm and openFDA.
export const SourceTraceSchema = z.object({
  rxnorm_ms: z.number().int(),
  openfda_ms: z.number().int(),
  openfda_requests: z.number().int(),
  // Per product type with a canonical label: how many labels its search matched.
  matches: z.partialRecord(ProductTypeSchema, LabelMatchSchema),
})
export type SourceTrace = z.infer<typeof SourceTraceSchema>

export const AnswersResponseSchema = z.object({
  rxcui: z.string(),
  ingredients: z.array(IngredientSchema),
  labels: z.array(LabelAnswersSchema),
  sources: SourceTraceSchema,
})
export type AnswersResponse = z.infer<typeof AnswersResponseSchema>

// A reader's question, after trimming: long enough for a sentence, short enough to stay a
// topic. Lengths count characters (code points), not UTF-16 units.
export const MIN_QUESTION_CHARS = 3
export const MAX_QUESTION_CHARS = 200

export function questionLength(text: string): number {
  return [...text.trim()].length
}

export const AskRequestSchema = z.object({
  // Which of the drug's canonical labels to read.
  set_id: z.string().min(1).max(64),
  question: z
    .string()
    .trim()
    .refine((q) => [...q].length >= MIN_QUESTION_CHARS, { message: 'Question too short' })
    .refine((q) => [...q].length <= MAX_QUESTION_CHARS, { message: 'Question too long' }),
})
export type AskRequest = z.infer<typeof AskRequestSchema>

export const AskResponseSchema = z.object({
  rxcui: z.string(),
  label: LabelInfoSchema,
  ...run,
  answer: CustomAnswerSchema,
  sources: SourceTraceSchema,
})
export type AskResponse = z.infer<typeof AskResponseSchema>

export const CandidateViewSchema = z.object({
  id: z.string(),
  text: z.string(),
  // Verbatim governing text for a bullet item. Show it with the candidate, never drop it.
  lead_in: z.string().nullable(),
})
export type CandidateView = z.infer<typeof CandidateViewSchema>

export const QuestionSectionsSchema = z.object({
  id: z.string(),
  group: GroupSchema,
  title: z.string(),
  // Label sections that may answer this question, in priority order. Empty means the label
  // layout has no section for it, such as a boxed warning on an OTC label.
  sections: z.array(z.string()),
})
export type QuestionSections = z.infer<typeof QuestionSectionsSchema>

export const LabelViewSchema = LabelInfoSchema.extend({
  questions: z.array(QuestionSectionsSchema),
  sections: z.record(z.string(), z.array(CandidateViewSchema)),
})
export type LabelView = z.infer<typeof LabelViewSchema>

export const LabelsResponseSchema = z.object({
  rxcui: z.string(),
  ingredients: z.array(IngredientSchema),
  labels: z.array(LabelViewSchema),
})
export type LabelsResponse = z.infer<typeof LabelsResponseSchema>
