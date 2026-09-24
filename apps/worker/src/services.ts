import type { Services } from './app.ts'
import { OpenFdaClient } from './clients/openfda.ts'
import { RxNormClient } from './clients/rxnorm.ts'
import { readConfig } from './config.ts'
import type { Env } from './env.ts'
import type { Fetch } from './http.ts'

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
  }
}
