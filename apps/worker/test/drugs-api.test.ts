import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { RxNormClient } from '../src/clients/rxnorm.ts'
import { PROBLEM_JSON, UpstreamError } from '../src/problems.ts'
import { testApp } from './helpers.ts'
import { rxnormFetch } from './recorded.ts'

const NAMES = ['advil', 'advil pm', 'glipiZIDE / metFORMIN', 'metFORMIN', 'tylenol pm']

function app(drugNames: () => Promise<readonly string[]> = async () => NAMES) {
  return testApp({
    rxnorm: new RxNormClient({ baseUrl: 'https://rxnav.test', fetch: rxnormFetch() }),
    drugNames,
  })
}

async function get(path: string, drugNames?: () => Promise<readonly string[]>): Promise<Response> {
  return app(drugNames).request(path, {}, env)
}

describe('drug suggestions', () => {
  it('match the start of a name or a word', async () => {
    const response = await get('/api/drugs/suggestions?q=metf')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      query: 'metf',
      names: ['metFORMIN', 'glipiZIDE / metFORMIN'],
    })
  })

  it.each(['a', 'x'.repeat(101)])('reject a query too short or too long: %s', async (q) => {
    const response = await get(`/api/drugs/suggestions?q=${q}`)

    expect(response.status).toBe(422)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
  })

  it('fail as a problem when RxNorm is down', async () => {
    const response = await get('/api/drugs/suggestions?q=adv', async () => {
      throw new UpstreamError('RxNorm request failed: /displaynames.json')
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
  })
})

describe('drug resolve', () => {
  it('turns a brand into its ingredient set', async () => {
    const response = await get('/api/drugs/resolve?name=Advil')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      query: 'Advil',
      rxcui: '5640',
      ingredients: [{ rxcui: '5640', name: 'ibuprofen' }],
    })
  })

  it('keeps combinations together', async () => {
    const body = (await (await get('/api/drugs/resolve?name=Tylenol%20PM')).json()) as {
      rxcui: string
      ingredients: { name: string }[]
    }

    expect(body.rxcui).toBe('214181')
    expect(body.ingredients.map((i) => i.name)).toEqual(['acetaminophen', 'diphenhydramine'])
  })

  it('answers an unknown name with a 404 problem', async () => {
    const response = await get('/api/drugs/resolve?name=xyzzynotadrug')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(((await response.json()) as { detail: string }).detail).toContain('xyzzynotadrug')
  })

  it('answers a missing name with a 422 problem', async () => {
    const response = await get('/api/drugs/resolve')

    expect(response.status).toBe(422)
    expect(((await response.json()) as { detail: string }).detail).toBe(
      'Invalid request: query.name',
    )
  })
})
