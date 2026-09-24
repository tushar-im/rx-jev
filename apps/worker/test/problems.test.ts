import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PROBLEM_JSON, ProblemError, parseOr422, registerProblemHandlers } from '../src/problems.ts'

function app(): Hono {
  const hono = new Hono()
  registerProblemHandlers(hono)
  hono.get('/boom', () => {
    throw new Error('secret internal detail')
  })
  hono.get('/teapot', () => {
    throw new ProblemError(418, 'short and stout')
  })
  hono.get('/slow-down', () => {
    throw new ProblemError(429, 'Too many.', { 'Retry-After': '30' })
  })
  hono.get('/needs-int', (c) => {
    const { n } = parseOr422(z.object({ n: z.coerce.number().int() }), c.req.query(), 'query')
    return c.json(n)
  })
  return hono
}

describe('Problem Details', () => {
  it('answers an unhandled exception with a generic 500', async () => {
    const response = await app().request('/boom')

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
    })
  })

  it('never leaks the internals of an unhandled exception', async () => {
    const text = await (await app().request('/boom')).text()

    expect(text).not.toContain('secret internal detail')
    expect(text).not.toContain('Error:')
  })

  it('keeps the status and detail of a deliberate error', async () => {
    const response = await app().request('/teapot')

    expect(response.status).toBe(418)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(((await response.json()) as { detail: string }).detail).toBe('short and stout')
  })

  it('keeps headers such as Retry-After', async () => {
    const response = await app().request('/slow-down')

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
  })

  it('names the invalid fields of a request', async () => {
    const response = await app().request('/needs-int?n=not-a-number')

    expect(response.status).toBe(422)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(((await response.json()) as { detail: string }).detail).toBe('Invalid request: query.n')
  })
})
