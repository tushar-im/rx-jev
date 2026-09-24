import type { Hono } from 'hono'
import { type AppEnv, createApp, type Services } from '../src/app.ts'
import { OpenFdaClient } from '../src/clients/openfda.ts'
import { RxNormClient } from '../src/clients/rxnorm.ts'
import { readConfig } from '../src/config.ts'
import { openfdaFetch, rxnormFetch } from './recorded.ts'

export const RXNORM_BASE = 'https://rxnav.test'
export const OPENFDA_BASE = 'https://fda.test'

export function recordedRxNorm(): RxNormClient {
  return new RxNormClient({ baseUrl: RXNORM_BASE, fetch: rxnormFetch() })
}

export function recordedOpenFda(): OpenFdaClient {
  return new OpenFdaClient({ baseUrl: OPENFDA_BASE, fetch: openfdaFetch() })
}

/** Services on recorded upstreams. */
export function testServices(overrides: Partial<Services> = {}): Services {
  const rxnorm = recordedRxNorm()
  return {
    config: readConfig({}),
    rxnorm,
    openfda: recordedOpenFda(),
    drugNames: () => rxnorm.displayNames(),
    ...overrides,
  }
}

export function testApp(overrides: Partial<Services> = {}): Hono<AppEnv> {
  return createApp(() => testServices(overrides))
}
