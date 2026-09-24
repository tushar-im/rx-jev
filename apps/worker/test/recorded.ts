import type { Fetch } from '../src/http.ts'

// Replays recorded upstream responses. Any unrecorded request fails the test.

const FIXTURES = import.meta.glob<unknown>('../../../fixtures/{rxnorm,openfda}/*.json', {
  eager: true,
  import: 'default',
})

function fixture(name: string): unknown {
  return FIXTURES[`../../../fixtures/${name}`]
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A fetch answered by `handler`, which sees the parsed URL. */
export function mockFetch(handler: (url: URL) => Response | Promise<Response>): Fetch {
  return async (input) => handler(new URL(input))
}

export function rxnormFetch(): Fetch {
  return mockFetch((url) => {
    const path = url.pathname
    let name: string
    if (path.endsWith('/rxcui.json')) {
      const query = (url.searchParams.get('name') ?? '').toLowerCase().replaceAll(' ', '_')
      name = `rxnorm/rxcui_${query}.json`
    } else if (path.endsWith('/related.json')) {
      name = `rxnorm/related_${path.split('/').at(-2)}.json`
    } else if (path.endsWith('/displaynames.json')) {
      name = 'rxnorm/displaynames.json'
    } else {
      throw new Error(`Unexpected request: ${url}`)
    }
    const body = fixture(name)
    if (body === undefined) throw new Error(`Unrecorded request: ${url}`)
    return json(200, body)
  })
}

async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

type Envelope = { status: number; body: unknown }

export function openfdaFetch(): Fetch {
  // Names match apps/api/scripts/record_openfda.py.
  return mockFetch(async (url) => {
    const p = url.searchParams
    const key = `${p.get('search')}|${p.get('skip')}|${p.get('limit')}`
    const envelope = fixture(`openfda/${(await sha1(key)).slice(0, 12)}.json`) as
      | Envelope
      | undefined
    if (envelope === undefined) throw new Error(`Unrecorded request: ${url}`)
    return json(envelope.status, envelope.body)
  })
}

/** A fetch that fails the test if called at all. */
export function unreachable(): Fetch {
  return mockFetch((url) => {
    throw new Error(`Unexpected upstream request: ${url}`)
  })
}
