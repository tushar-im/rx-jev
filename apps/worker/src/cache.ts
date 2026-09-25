import { type DrugNames, DrugNamesSchema, LabelMatchSchema } from '@rx-jev/contract'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { type CanonicalLabels, LabelSchema, OpenFdaClient } from './clients/openfda.ts'
import type { RxNormClient } from './clients/rxnorm.ts'
import type { Db } from './db/index.ts'
import { openfdaCache } from './db/schema.ts'
import type { Http } from './http.ts'
import { UpstreamError } from './problems.ts'

// Caches for slow-changing upstream data. openFDA takes 4 to 8 seconds to find a drug's
// canonical labels, and labels change a few times a year, so a lookup is reused for a day,
// and an older one is served when openFDA fails.
// RxNorm's name list for suggestions is refreshed daily by a Cron Trigger.

export const CACHE_MS = 86_400_000

const CachedLookup = z.object({
  otc: LabelSchema.nullable(),
  prescription: LabelSchema.nullable(),
  matches: z.partialRecord(z.enum(['otc', 'prescription']), LabelMatchSchema),
})

/**
 * openFDA with lookups kept in D1 for 24 hours, or longer when openFDA fails. A failed
 * lookup is never kept.
 */
export class CachedOpenFda extends OpenFdaClient {
  readonly #db: Db
  readonly #now: () => number

  constructor(http: Http, apiKey: string | null, db: Db, now: () => number = Date.now) {
    super(http, apiKey)
    this.#db = db
    this.#now = now
  }

  override async canonicalLabels(ingredients: string[]): Promise<CanonicalLabels> {
    const key = JSON.stringify(ingredients)
    const now = this.#now()
    const [row] = await this.#db
      .select()
      .from(openfdaCache)
      .where(eq(openfdaCache.key, key))
      .limit(1)
    const saved = row ? CachedLookup.safeParse(row.body) : null
    // No openFDA search is made for a cached lookup.
    if (saved?.success && row && now - row.fetched_at_ms < CACHE_MS) {
      return {
        ...saved.data,
        requests: 0,
        cached: true,
        stale: false,
        fetchedAt: row.fetched_at_ms,
      }
    }

    let fresh: CanonicalLabels
    try {
      fresh = await super.canonicalLabels(ingredients)
    } catch (error) {
      // Labels change a few times a year, so an older lookup beats a failed one.
      if (error instanceof UpstreamError && saved?.success && row) {
        console.warn(`openFDA failed; serving a lookup older than a day for ${key}`)
        // Not a cache hit: the trace must say openFDA was tried, and how old this lookup is.
        return {
          ...saved.data,
          requests: this.requestsMade,
          cached: false,
          stale: true,
          fetchedAt: row.fetched_at_ms,
        }
      }
      throw error
    }
    const body = { otc: fresh.otc, prescription: fresh.prescription, matches: fresh.matches }
    await this.#db
      .insert(openfdaCache)
      .values({ key, body, fetched_at_ms: now })
      .onConflictDoUpdate({ target: openfdaCache.key, set: { body, fetched_at_ms: now } })
    return fresh
  }
}

export const DRUG_NAMES_KEY = 'rxnorm:displaynames'

/** Fetches RxNorm's display names and saves them to KV, for the daily Cron Trigger. */
export async function refreshDrugNames(
  rxnorm: RxNormClient,
  kv: KVNamespace,
  now: () => number = Date.now,
): Promise<DrugNames> {
  const list = { names: await rxnorm.displayNames(), updated_at: new Date(now()).toISOString() }
  await kv.put(DRUG_NAMES_KEY, JSON.stringify(list))
  return list
}

/** RxNorm's display names from KV, fetched and saved first if KV has none yet. */
export async function kvDrugNames(rxnorm: RxNormClient, kv: KVNamespace): Promise<DrugNames> {
  const saved = DrugNamesSchema.safeParse(await kv.get(DRUG_NAMES_KEY, 'json'))
  return saved.success ? saved.data : refreshDrugNames(rxnorm, kv)
}
