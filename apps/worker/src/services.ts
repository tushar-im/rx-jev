import { TypeSafeClient } from '@typesafe-ai/sdk'
import type { Services } from './app.ts'
import { OpenFdaClient } from './clients/openfda.ts'
import { RxNormClient } from './clients/rxnorm.ts'
import { type Config, readConfig } from './config.ts'
import type { Env } from './env.ts'
import { createDb } from './db/index.ts'
import type { Fetch } from './http.ts'
import { durableAskLimiter } from './limiter.ts'
import { Judge } from './judge.ts'
import { Store } from './store.ts'

const globalFetch: Fetch = (input, init) => fetch(input, init)

// Fetched once per isolate; a failed fetch is not kept, so the next request retries.
const drugNamesByUrl = new Map<string, Promise<readonly string[]>>()

function drugNames(rxnorm: RxNormClient, baseUrl: string): Promise<readonly string[]> {
  let names = drugNamesByUrl.get(baseUrl)
  if (names === undefined) {
    names = rxnorm.displayNames()
    names.catch(() => drugNamesByUrl.delete(baseUrl))
    drugNamesByUrl.set(baseUrl, names)
  }
  return names
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

// The production services, from the Worker's bindings.
export function workerServices(env: Env): Services {
  const config = readConfig({ ...env })
  const rxnorm = new RxNormClient({ baseUrl: config.rxnormBaseUrl, fetch: globalFetch })
  return {
    config,
    rxnorm,
    openfda: new OpenFdaClient(
      { baseUrl: config.openfdaBaseUrl, fetch: globalFetch },
      config.openfdaApiKey,
    ),
    drugNames: () => drugNames(rxnorm, config.rxnormBaseUrl),
    judge: new Judge(jevClient(config), config.typesafeModel),
    store: new Store(createDb(env.DB)),
    askLimiter: durableAskLimiter(env.ASK_LIMITER, [
      { count: config.askPerMinute, seconds: 60 },
      { count: config.askPerDay, seconds: 86_400 },
    ]),
  }
}
