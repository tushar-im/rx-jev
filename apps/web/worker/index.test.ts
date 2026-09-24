// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { route, type WebEnv } from './index.ts'

function fetcher(name: string, seen: string[]): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      seen.push(`${name} ${new URL(input instanceof Request ? input.url : String(input)).pathname}`)
      return new Response(name)
    },
    connect: () => {
      throw new Error('Not used')
    },
  } as Fetcher
}

function env(seen: string[]): WebEnv {
  return { API: fetcher('api', seen), ASSETS: fetcher('assets', seen) }
}

describe('the web Worker', () => {
  it('sends /api requests to the API Worker on the same origin', async () => {
    const seen: string[] = []
    const response = await route(new Request('https://rx-jev.test/api/labels/5640/answers'), env(seen))

    expect(await response.text()).toBe('api')
    expect(seen).toEqual(['api /api/labels/5640/answers'])
  })

  it('keeps the client address the rate limit is keyed on', async () => {
    let forwarded: string | null = null
    const api = {
      fetch: async (input: RequestInfo | URL) => {
        forwarded = input instanceof Request ? input.headers.get('CF-Connecting-IP') : null
        return new Response('api')
      },
    } as Fetcher
    const request = new Request('https://rx-jev.test/api/labels/5640/ask', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    })
    await route(request, { API: api, ASSETS: fetcher('assets', []) })

    expect(forwarded).toBe('203.0.113.7')
  })

  it('serves everything else from the static build', async () => {
    const seen: string[] = []
    const response = await route(new Request('https://rx-jev.test/'), env(seen))

    expect(await response.text()).toBe('assets')
    expect(seen).toEqual(['assets /'])
  })

  it('does not treat a path that only starts with "api" as the API', async () => {
    const seen: string[] = []
    await route(new Request('https://rx-jev.test/apiary'), env(seen))

    expect(seen).toEqual(['assets /apiary'])
  })
})
