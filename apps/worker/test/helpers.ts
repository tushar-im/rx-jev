import type { Hono } from 'hono'
import { type AppEnv, createApp, type Services } from '../src/app.ts'
import { type CanonicalLabels, type Label, OpenFdaClient } from '../src/clients/openfda.ts'
import { RxNormClient } from '../src/clients/rxnorm.ts'
import { readConfig } from '../src/config.ts'
import { createDb } from '../src/db/index.ts'
import { judgeRuns } from '../src/db/schema.ts'
import type { Env } from '../src/env.ts'
import { type ClientLimiter, RateLimiter } from '../src/ratelimit.ts'
import { Judge } from '../src/judge.ts'
import { Store } from '../src/store.ts'
import type { FakeJev } from './jev.ts'
import { openfdaFetch, rxnormFetch, unreachable } from './recorded.ts'

export const RXNORM_BASE = 'https://rxnav.test'
export const OPENFDA_BASE = 'https://fda.test'
export const METFORMIN = '6809'
export const IBUPROFEN = '5640'

export function recordedRxNorm(): RxNormClient {
  return new RxNormClient({ baseUrl: RXNORM_BASE, fetch: rxnormFetch() })
}

export function recordedOpenFda(): OpenFdaClient {
  return new OpenFdaClient({ baseUrl: OPENFDA_BASE, fetch: openfdaFetch() })
}

/** openFDA returning a fixed canonical prescription label, without any HTTP. */
export class OneLabel extends OpenFdaClient {
  readonly #label: Label

  constructor(label: Label) {
    super({ baseUrl: OPENFDA_BASE, fetch: unreachable() })
    this.#label = label
  }

  override async canonicalLabels(): Promise<CanonicalLabels> {
    return { otc: null, prescription: this.#label, matches: {}, requests: 0 }
  }
}

/** A limiter kept in memory, so tests can inspect and drive it. */
export function memoryLimiter(limiter: RateLimiter): ClientLimiter {
  return {
    acquire: async (client) => limiter.acquire(client),
    release: async (slot) => limiter.release(slot),
  }
}

export type TestOverrides = Partial<Services> & { jev?: FakeJev | null }

/** Services on recorded upstreams, the test D1 and a fake Jev (unconfigured when null). */
export function testServices(env: Env, overrides: TestOverrides = {}): Services {
  const { jev, ...rest } = overrides
  const rxnorm = recordedRxNorm()
  return {
    config: readConfig({}),
    rxnorm,
    openfda: recordedOpenFda(),
    drugNames: () => rxnorm.displayNames(),
    judge: new Judge(jev?.client() ?? null, 'jev-latest'),
    store: new Store(createDb(env.DB)),
    askLimiter: memoryLimiter(new RateLimiter([])),
    ...rest,
  }
}

export function testApp(overrides: TestOverrides = {}): Hono<AppEnv> {
  return createApp((env) => testServices(env, overrides))
}

export async function runs(env: Env): Promise<number> {
  return (await createDb(env.DB).select().from(judgeRuns)).length
}
