import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CachedOpenFda, DRUG_NAMES_KEY, kvDrugNames, refreshDrugNames } from '../src/cache.ts'
import { RxNormClient } from '../src/clients/rxnorm.ts'
import { readConfig } from '../src/config.ts'
import { createDb } from '../src/db/index.ts'
import type { Fetch } from '../src/http.ts'
import { IBUPROFEN, OPENFDA_BASE, RXNORM_BASE, testApp } from './helpers.ts'
import { FakeJev } from './jev.ts'
import { openfdaFetch, rxnormFetch } from './recorded.ts'

const DAY_MS = 86_400_000

function counting(fetch: Fetch): { fetch: Fetch; calls: () => number } {
  let calls = 0
  return {
    fetch: (input, init) => {
      calls += 1
      return fetch(input, init)
    },
    calls: () => calls,
  }
}

function cachedOpenFda(fetch: Fetch, now: () => number): CachedOpenFda {
  return new CachedOpenFda({ baseUrl: OPENFDA_BASE, fetch }, null, createDb(env.DB), now)
}

describe('the openFDA lookup cache', () => {
  it('serves a repeat lookup from D1 without calling openFDA', async () => {
    const upstream = counting(openfdaFetch())
    const openfda = cachedOpenFda(upstream.fetch, () => 1_000)
    const first = await openfda.canonicalLabels(['ibuprofen'])
    const calls = upstream.calls()
    const second = await openfda.canonicalLabels(['ibuprofen'])

    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(upstream.calls()).toBe(calls)
    expect(second.otc).toEqual(first.otc)
    expect(second.prescription).toEqual(first.prescription)
    expect(second.matches).toEqual(first.matches)
    // No openFDA search was made for the cached lookup.
    expect(second.requests).toBe(0)
  })

  it('looks up again after 24 hours', async () => {
    const upstream = counting(openfdaFetch())
    let now = 1_000
    const openfda = cachedOpenFda(upstream.fetch, () => now)
    await openfda.canonicalLabels(['ibuprofen'])
    const calls = upstream.calls()

    now += DAY_MS + 1
    const again = await openfda.canonicalLabels(['ibuprofen'])
    expect(again.cached).toBe(false)
    expect(upstream.calls()).toBeGreaterThan(calls)
    now += 1
    expect((await openfda.canonicalLabels(['ibuprofen'])).cached).toBe(true)
  })

  it('keys lookups by the ingredient set', async () => {
    const openfda = cachedOpenFda(openfdaFetch(), () => 1_000)
    await openfda.canonicalLabels(['ibuprofen'])

    expect((await openfda.canonicalLabels(['metformin'])).cached).toBe(false)
  })

  it('says in the trace when the lookup came from the cache', async () => {
    const app = testApp({
      jev: new FakeJev(),
      openfda: cachedOpenFda(openfdaFetch(), () => 1_000),
    })
    const get = async () =>
      (
        (await (await app.request(`/api/labels/${IBUPROFEN}/answers`, {}, env)).json()) as {
          sources: { openfda_cached: boolean; openfda_requests: number }
        }
      ).sources

    expect((await get()).openfda_cached).toBe(false)
    const cached = await get()
    expect(cached.openfda_cached).toBe(true)
    expect(cached.openfda_requests).toBe(0)
  })

  it('serves an old lookup when openFDA fails, rather than a 502', async () => {
    let now = 1_000
    let fail = false
    const flaky: Fetch = async (input, init) =>
      fail ? new Response('down', { status: 503 }) : openfdaFetch()(input, init)
    const openfda = cachedOpenFda(flaky, () => now)
    const first = await openfda.canonicalLabels(['ibuprofen'])

    now += 30 * DAY_MS
    fail = true
    const stale = await openfda.canonicalLabels(['ibuprofen'])
    expect(stale.cached).toBe(true)
    expect(stale.otc).toEqual(first.otc)
  })

  it('still fails when openFDA fails and nothing is cached', async () => {
    const down: Fetch = async () => new Response('down', { status: 503 })

    await expect(cachedOpenFda(down, () => 1_000).canonicalLabels(['ibuprofen'])).rejects.toThrow()
  })

  it('does not cache a failed lookup', async () => {
    let fail = true
    const flaky: Fetch = async (input, init) =>
      fail ? new Response('down', { status: 503 }) : openfdaFetch()(input, init)
    const openfda = cachedOpenFda(flaky, () => 1_000)

    await expect(openfda.canonicalLabels(['ibuprofen'])).rejects.toThrow()
    fail = false
    expect((await openfda.canonicalLabels(['ibuprofen'])).cached).toBe(false)
  })
})

describe('RxNorm names in KV', () => {
  function rxnorm(fetch: Fetch = rxnormFetch()): RxNormClient {
    return new RxNormClient({ baseUrl: RXNORM_BASE, fetch })
  }

  it('are refreshed from RxNorm by the daily job', async () => {
    await refreshDrugNames(rxnorm(), env.CACHE, () => 1_000)
    const saved = (await env.CACHE.get(DRUG_NAMES_KEY, 'json')) as {
      names: string[]
      updated_at: string
    }

    expect(saved.names).toContain('advil')
    expect(saved.updated_at).toBe(new Date(1_000).toISOString())
  })

  it('are read from KV without calling RxNorm', async () => {
    await env.CACHE.put(
      DRUG_NAMES_KEY,
      JSON.stringify({ names: ['only-in-kv'], updated_at: '2026-09-25T00:00:00.000Z' }),
    )
    const upstream = counting(rxnormFetch())

    expect((await kvDrugNames(rxnorm(upstream.fetch), env.CACHE)).names).toEqual(['only-in-kv'])
    expect(upstream.calls()).toBe(0)
  })

  it('are fetched and saved when KV has none yet', async () => {
    const list = await kvDrugNames(rxnorm(), env.CACHE)

    expect(list.names).toContain('metFORMIN')
    expect(await env.CACHE.get(DRUG_NAMES_KEY)).not.toBeNull()
  })
})

describe('answers ETag', () => {
  async function answers(headers: Record<string, string> = {}, jev = new FakeJev()) {
    return testApp({ jev }).request(`/api/labels/${IBUPROFEN}/answers`, { headers }, env)
  }

  it('is not sent for answers judged by this request', async () => {
    const response = await answers()

    expect(response.headers.get('etag')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('lets a client revalidate stored answers with a 304', async () => {
    const jev = new FakeJev()
    await answers({}, jev)
    const stored = await answers({}, jev)
    const etag = stored.headers.get('etag') ?? ''

    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/)
    expect(stored.headers.get('cache-control')).toBe('private, no-cache')
    const revalidated = await answers({ 'If-None-Match': etag }, jev)
    expect(revalidated.status).toBe(304)
    expect(await revalidated.text()).toBe('')
  })

  it('changes with the display threshold', async () => {
    const jev = new FakeJev()
    await answers({}, jev)
    const before = (await answers({}, jev)).headers.get('etag')
    const after = (
      await testApp({
        jev,
        config: readConfig({ DISPLAY_MIN_CONFIDENCE: '0.5' }),
      }).request(`/api/labels/${IBUPROFEN}/answers`, {}, env)
    ).headers.get('etag')

    expect(after).not.toBe(before)
  })
})
