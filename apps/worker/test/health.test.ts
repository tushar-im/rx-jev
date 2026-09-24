import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { PROBLEM_JSON } from '../src/problems.ts'
import { testApp } from './helpers.ts'

describe('health', () => {
  it('reports ok', async () => {
    const response = await testApp().request('/api/health', {}, env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('answers an unknown route with Problem Details', async () => {
    const response = await testApp().request('/api/does-not-exist', {}, env)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe(404)
    expect(body.title).toBe('Not Found')
    expect(body.type).toBe('about:blank')
    expect(body).toHaveProperty('detail')
  })
})
