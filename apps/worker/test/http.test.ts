import { describe, expect, it } from 'vitest'
import { get, type Http } from '../src/http.ts'
import { UpstreamError } from '../src/problems.ts'

// Quick retries, so the tests do not wait on real backoff.
const FAST = { attempts: 3, timeoutMs: 50, backoffMs: 0 }

/** A fetch whose calls answer in turn: a status, a hang until aborted, or a network error. */
function upstream(replies: (number | 'hang' | 'error')[]): { http: Http; calls: () => number } {
  let calls = 0
  const http: Http = {
    baseUrl: 'https://upstream.test',
    retry: FAST,
    fetch: (_input, init) => {
      const reply = replies[Math.min(calls, replies.length - 1)]
      calls += 1
      if (reply === 'error') return Promise.reject(new TypeError('Network connection lost.'))
      if (reply === 'hang') {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      }
      return Promise.resolve(new Response('{}', { status: reply }))
    },
  }
  return { http, calls: () => calls }
}

describe('upstream GET', () => {
  it('retries a call that hangs, then succeeds', async () => {
    const { http, calls } = upstream(['hang', 'hang', 200])

    expect((await get(http, '/x', {}, 'lookup failed')).status).toBe(200)
    expect(calls()).toBe(3)
  })

  it('retries network errors, rate limits and server errors', async () => {
    for (const first of ['error', 429, 503] as const) {
      const { http, calls } = upstream([first, 200])
      expect((await get(http, '/x', {}, 'lookup failed')).status).toBe(200)
      expect(calls()).toBe(2)
    }
  })

  it('gives up after the last attempt and says why', async () => {
    const { http, calls } = upstream(['hang'])

    const failure = get(http, '/x', {}, 'lookup failed')
    await expect(failure).rejects.toBeInstanceOf(UpstreamError)
    await expect(failure).rejects.toThrow(/lookup failed: .*time/i)
    expect(calls()).toBe(3)
  })

  it('does not retry an answer that will not change', async () => {
    for (const status of [200, 400, 403, 404]) {
      const { http, calls } = upstream([status])
      expect((await get(http, '/x', {}, 'lookup failed')).status).toBe(status)
      expect(calls()).toBe(1)
    }
  })

  it('says who is calling', async () => {
    let agent: string | null = null
    const http: Http = {
      baseUrl: 'https://upstream.test',
      fetch: async (_input, init) => {
        agent = new Headers(init?.headers).get('User-Agent')
        return new Response('{}')
      },
    }
    await get(http, '/x', {}, 'lookup failed')

    expect(agent).toBe('rx-jev (+https://rxjev.cc)')
  })
})
