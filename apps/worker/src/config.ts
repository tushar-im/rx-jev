import { z } from 'zod'

// Agreed at Gate 1: a category is shown only when both its stance and evidence confidence
// reach this. At 0.9 the blind second read agreed with Jev's stance on 81 of 83 rows.
export const GATE_1_MIN_CONFIDENCE = 0.9
// The Jev version those thresholds were validated on. Runs reporting another version are
// flagged by the batch script until the thresholds are re-checked for it.
export const GATE_1_MODEL_VERSION = 'jev-1.13.0'

// Wrangler vars and secrets arrive as strings; every one is validated here.
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : null))

export const ConfigSchema = z.object({
  TYPESAFE_API_KEY: optionalSecret,
  TYPESAFE_MODEL: z.string().min(1).default('jev-latest'),
  OPENFDA_API_KEY: optionalSecret,
  OPENFDA_BASE_URL: z.url().default('https://api.fda.gov'),
  RXNORM_BASE_URL: z.url().default('https://rxnav.nlm.nih.gov/REST'),
  DISPLAY_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(GATE_1_MIN_CONFIDENCE),
  VALIDATED_MODEL_VERSION: z.string().min(1).default(GATE_1_MODEL_VERSION),
  // Custom questions call Jev live, so each client may ask this many per minute and per day.
  ASK_PER_MINUTE: z.coerce.number().int().min(1).default(5),
  ASK_PER_DAY: z.coerce.number().int().min(1).default(50),
})

export type Config = {
  typesafeApiKey: string | null
  typesafeModel: string
  openfdaApiKey: string | null
  openfdaBaseUrl: string
  rxnormBaseUrl: string
  displayMinConfidence: number
  validatedModelVersion: string
  askPerMinute: number
  askPerDay: number
}

export function readConfig(vars: Record<string, unknown>): Config {
  const c = ConfigSchema.parse(vars)
  return {
    typesafeApiKey: c.TYPESAFE_API_KEY,
    typesafeModel: c.TYPESAFE_MODEL,
    openfdaApiKey: c.OPENFDA_API_KEY,
    openfdaBaseUrl: c.OPENFDA_BASE_URL,
    rxnormBaseUrl: c.RXNORM_BASE_URL,
    displayMinConfidence: c.DISPLAY_MIN_CONFIDENCE,
    validatedModelVersion: c.VALIDATED_MODEL_VERSION,
    askPerMinute: c.ASK_PER_MINUTE,
    askPerDay: c.ASK_PER_DAY,
  }
}
