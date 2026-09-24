import type { Context, Hono, Env as HonoEnv } from 'hono'
import type { z } from 'zod'

// RFC 7807 Problem Details for every error the API returns.

export const PROBLEM_JSON = 'application/problem+json'

const PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  418: "I'm a Teapot",
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

/** An error the API means to return, with its status, detail and headers. */
export class ProblemError extends Error {
  readonly status: number
  readonly detail: string
  readonly headers: Record<string, string>

  constructor(status: number, detail: string, headers: Record<string, string> = {}) {
    super(detail)
    this.status = status
    this.detail = detail
    this.headers = headers
  }
}

/** An external data source failed or returned a payload we could not parse. */
export class UpstreamError extends Error {}

/** Jev is not configured, failed, or answered outside a question's options. */
export class JudgeError extends Error {}

export function problem(
  status: number,
  detail: string,
  headers: Record<string, string> = {},
  type = 'about:blank',
): Response {
  const body = { type, title: PHRASES[status] ?? 'Error', status, detail }
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': PROBLEM_JSON },
  })
}

/** The value parsed by `schema`, or a 422 naming each invalid field as `where.field`. */
export function parseOr422<S extends z.ZodType>(
  schema: S,
  value: unknown,
  where: 'query' | 'path' | 'body',
): z.infer<S> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const fields = result.error.issues.map((issue) => [where, ...issue.path.map(String)].join('.'))
  throw new ProblemError(422, `Invalid request: ${[...new Set(fields)].join(', ')}`)
}

function describe(c: Context): string {
  return `${c.req.method} ${new URL(c.req.url).pathname}`
}

export function registerProblemHandlers<E extends HonoEnv>(app: Hono<E>): void {
  app.notFound(() => problem(404, 'Not Found'))
  app.onError((error, c) => {
    if (error instanceof ProblemError) return problem(error.status, error.detail, error.headers)
    if (error instanceof UpstreamError) {
      console.warn(`Upstream failure on ${describe(c)}`, error)
      return problem(502, 'A drug data source is unavailable. Try again later.')
    }
    if (error instanceof JudgeError) {
      console.warn(`Jev failure on ${describe(c)}`, error)
      return problem(503, 'Answers are unavailable right now. Try again later.')
    }
    // Log the real cause server-side; never send it to the client.
    console.error(`Unhandled exception on ${describe(c)}`, error)
    return problem(500, 'An unexpected error occurred.')
  })
}
