import type { z } from 'zod'
import { UpstreamError } from './problems.ts'

/** A fetch compatible with the global one; tests pass one that replays recordings. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type Http = { baseUrl: string; fetch: Fetch }

export const UPSTREAM_TIMEOUT_MS = 20_000

export function url(http: Http, path: string, params: Record<string, string | number>): string {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const suffix = query.size > 0 ? `?${query}` : ''
  return `${http.baseUrl.replace(/\/+$/, '')}${path}${suffix}`
}

/** One GET, as a response; a network failure or timeout raises UpstreamError. */
export async function get(
  http: Http,
  path: string,
  params: Record<string, string | number>,
  what: string,
): Promise<Response> {
  try {
    return await http.fetch(url(http, path, params), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new UpstreamError(what, { cause })
  }
}

/** The response body parsed by `schema`; a bad status or payload raises UpstreamError. */
export async function parseBody<S extends z.ZodType>(
  response: Response,
  schema: S,
  what: string,
): Promise<z.infer<S>> {
  if (!response.ok) throw new UpstreamError(`${what}: HTTP ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new UpstreamError(what, { cause })
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new UpstreamError(what, { cause: parsed.error })
  return parsed.data
}
