import type { AskLimiter } from './limiter.ts'

// The API Worker's bindings, as declared in wrangler.jsonc.
export interface Env {
  DB: D1Database
  // RxNorm's display name list and other slow-changing upstream data.
  CACHE: KVNamespace
  // One rate limiter object per client address.
  ASK_LIMITER: DurableObjectNamespace<AskLimiter>
  // Secrets.
  TYPESAFE_API_KEY?: string
  OPENFDA_API_KEY?: string
  // Vars; see config.ts for defaults.
  TYPESAFE_MODEL?: string
  OPENFDA_BASE_URL?: string
  RXNORM_BASE_URL?: string
  DISPLAY_MIN_CONFIDENCE?: string
  VALIDATED_MODEL_VERSION?: string
  ASK_PER_MINUTE?: string
  ASK_PER_DAY?: string
}
