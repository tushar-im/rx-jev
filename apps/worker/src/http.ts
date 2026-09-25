import type { z } from 'zod'
import { UpstreamError } from './problems.ts'

/** A fetch compatible with the global one; tests pass one that replays recordings. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** How a GET is retried when the upstream stalls, drops the connection or is overloaded. */
export type Retry = { attempts: number; timeoutMs: number; backoffMs: number }

export type Http = { baseUrl: string; fetch: Fetch; retry?: Retry }

// openFDA sometimes accepts a connection from Cloudflare and never answers, while a new
// attempt goes through in about a second. So attempts are short and retried, rather than
// one long wait.
export const UPSTREAM_RETRY: Retry = { attempts: 3, timeoutMs: 8_000, backoffMs: 250 }

const USER_AGENT = 'rx-jev (+https://rxjev.cc)'

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

export function url(http: Http, path: string, params: Record<string, string | number>): string {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
  )
  const suffix = query.size > 0 ? `?${query}` : ''
  return `${http.baseUrl.replace(/\/+$/, '')}${path}${suffix}`
}

/**
 * One GET, as a response. A timeout, a network failure, 408, 429 or 5xx is retried; if the
 * last attempt still fails, a network failure or timeout raises UpstreamError and a bad
 * status is returned for the caller to judge.
 */
export async function get(
  http: Http,
  path: string,
  params: Record<string, string | number>,
  what: string,
): Promise<Response> {
  const retry = http.retry ?? UPSTREAM_RETRY
  const target = url(http, path, params)
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= retry.attempts
    try {
      const response = await http.fetch(target, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(retry.timeoutMs),
      })
      if (last || !retryable(response.status)) return response
      // Free the connection before trying again.
      await response.body?.cancel()
    } catch (cause) {
      if (last) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        throw new UpstreamError(`${what}: ${reason} (after ${attempt} attempts)`, { cause })
      }
    }
    await sleep(retry.backoffMs * 2 ** (attempt - 1))
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
    throw new UpstreamError(`${what}: the body is not JSON`, { cause })
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new UpstreamError(`${what}: unexpected payload`, { cause: parsed.error })
  }
  return parsed.data
}
