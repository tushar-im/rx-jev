import type { DrugNames } from '@rx-jev/contract'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import type { Services } from './app.ts'
import { CachedOpenFda, kvDrugNames } from './cache.ts'
import { RxNormClient } from './clients/rxnorm.ts'
import { type Config, readConfig } from './config.ts'
import type { Env } from './env.ts'
import { createDb } from './db/index.ts'
import type { Fetch } from './http.ts'
import { durableAskLimiter } from './limiter.ts'
import { Judge } from './judge.ts'
import { Store } from './store.ts'

const globalFetch: Fetch = (input, init) => fetch(input, init)

// RxNorm's names are read from KV at most once an hour per isolate; a failed read is not
// kept, so the next request retries.
const NAMES_TTL_MS = 3_600_000
let drugNamesMemo: { list: Promise<DrugNames>; at: number } | null = null

function drugNames(rxnorm: RxNormClient, kv: KVNamespace): Promise<DrugNames> {
  if (drugNamesMemo === null || Date.now() - drugNamesMemo.at > NAMES_TTL_MS) {
    const list = kvDrugNames(rxnorm, kv)
    list.catch(() => {
      drugNamesMemo = null
    })
    drugNamesMemo = { list, at: Date.now() }
  }
  return drugNamesMemo.list
}

// One Jev request carries a whole label (roughly 30K tokens for long prescription labels).
const JEV_TIMEOUT_MS = 60_000

// Without a key the judge still serves stored answers; only a store miss fails.
function jevClient(config: Config): TypeSafeClient | null {
  if (config.typesafeApiKey === null) return null
  return new TypeSafeClient({
    apiKey: config.typesafeApiKey,
    timeout: JEV_TIMEOUT_MS,
    // The SDK retries 408, 429 and 5xx with backoff; two retries bound the total wait.
    retry: { maxRetries: 2 },
    logLevel: 'warn',
  })
}

export function rxnormClient(config: Config): RxNormClient {
  return new RxNormClient({ baseUrl: config.rxnormBaseUrl, fetch: globalFetch })
}

// The production services, from the Worker's bindings.
export function workerServices(env: Env): Services {
  const config = readConfig({ ...env })
  const rxnorm = rxnormClient(config)
  const db = createDb(env.DB)
  return {
    config,
    rxnorm,
    openfda: new CachedOpenFda(
      { baseUrl: config.openfdaBaseUrl, fetch: globalFetch },
      config.openfdaApiKey,
      db,
    ),
    drugNames: () => drugNames(rxnorm, env.CACHE),
    judge: new Judge(jevClient(config), config.typesafeModel),
    store: new Store(db),
    askLimiter: durableAskLimiter(env.ASK_LIMITER, [
      { count: config.askPerMinute, seconds: 60 },
      { count: config.askPerDay, seconds: 86_400 },
    ]),
  }
}
