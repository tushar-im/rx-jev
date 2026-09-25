import { describe, expect, it } from 'vitest'
import { SMOKE_DRUGS, smoke } from '../../scripts/lib/smoke.ts'
import type { Fetch } from '../../src/http.ts'

function answers(fresh: boolean): unknown {
  return { labels: [{ product_type: 'otc', version: '9', fresh }] }
}

function site(fresh: boolean, seen: { url: string; headers: Headers }[] = []): Fetch {
  return async (input, init) => {
    seen.push({ url: input, headers: new Headers(init?.headers) })
    const url = new URL(input)
    const body =
      url.pathname === '/api/health'
        ? { status: 'ok' }
        : url.pathname === '/api/drugs/resolve'
          ? { rxcui: '214181' }
          : answers(fresh)
    return new Response(JSON.stringify(body), { status: 200 })
  }
}

describe('the deploy smoke test', () => {
  it('passes when every drug is served from the store', async () => {
    const result = await smoke('https://rx-jev.test', site(false))

    expect(result.ok).toBe(true)
    expect(result.lines).toHaveLength(SMOKE_DRUGS.length + 1)
  })

  it('fails when a label had to be judged, since that calls Jev', async () => {
    const result = await smoke('https://rx-jev.test', site(true))

    expect(result.ok).toBe(false)
    expect(result.lines.join('\n')).toContain('judged now')
  })

  it('sends the Access service token when given one', async () => {
    const seen: { url: string; headers: Headers }[] = []
    await smoke('https://rx-jev.test', site(false, seen), { id: 'client-id', secret: 'shh' })

    expect(seen.every((s) => s.headers.get('CF-Access-Client-Id') === 'client-id')).toBe(true)
    expect(seen.every((s) => s.headers.get('CF-Access-Client-Secret') === 'shh')).toBe(true)
  })

  it('fails when the site does not answer', async () => {
    const down: Fetch = async () => new Response('Forbidden', { status: 403 })

    expect((await smoke('https://rx-jev.test', down)).ok).toBe(false)
  })
})
