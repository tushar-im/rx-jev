import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../src/catalog.ts'
import { OpenFdaClient } from '../src/clients/openfda.ts'
import { RxNormClient } from '../src/clients/rxnorm.ts'
import { PROBLEM_JSON } from '../src/problems.ts'
import { type Services } from '../src/app.ts'
import { testApp } from './helpers.ts'
import { json, mockFetch } from './recorded.ts'

type Body = {
  rxcui: string
  ingredients: { rxcui: string; name: string }[]
  labels: {
    set_id: string
    version: string
    effective_time: string
    dailymed_url: string
    layout: string
    product_type: string
    questions: { id: string; title: string; group: string; sections: string[] }[]
    sections: Record<string, { id: string; text: string; lead_in: string | null }[]>
  }[]
}

async function get(path: string, overrides: Partial<Services> = {}): Promise<Response> {
  return testApp(overrides).request(path, {}, env)
}

async function body(path: string): Promise<Body> {
  return (await (await get(path)).json()) as Body
}

describe('labels', () => {
  it('returns one label per available type', async () => {
    const response = await get('/api/labels/5640')

    expect(response.status).toBe(200)
    const data = (await response.json()) as Body
    expect(data.rxcui).toBe('5640')
    expect(data.ingredients).toEqual([{ rxcui: '5640', name: 'ibuprofen' }])
    expect(data.labels.map((l) => l.product_type)).toEqual(['otc', 'prescription'])
  })

  it('carries provenance', async () => {
    const otc = (await body('/api/labels/5640')).labels[0]

    expect(otc?.set_id).toBe('0ca02f8b-4413-4e7c-a67b-8c67c53e1343')
    expect(otc?.version).toBe('5')
    expect(otc?.effective_time).toBe('2026-09-09')
    expect(otc?.dailymed_url.endsWith('setid=0ca02f8b-4413-4e7c-a67b-8c67c53e1343')).toBe(true)
    expect(otc?.layout).toBe('otc')
  })

  it('lists the candidate sections of every catalog question', async () => {
    const otc = (await body('/api/labels/5640')).labels[0]
    const questions = new Map(otc?.questions.map((q) => [q.id, q]))

    expect([...questions.keys()]).toEqual(CATALOG.map((q) => q.id))
    expect(questions.get('pregnancy')?.title).toBe('Pregnancy')
    expect(questions.get('pregnancy')?.group).toBe('who')
    expect(questions.get('pregnancy')?.sections).toEqual(['pregnancy_or_breast_feeding'])
    expect(questions.get('boxed_warning')?.sections).toEqual([])
  })

  it('holds verbatim candidates for referenced sections only', async () => {
    const otc = (await body('/api/labels/5640')).labels[0]
    const referenced = new Set(otc?.questions.flatMap((q) => q.sections))

    expect(new Set(Object.keys(otc?.sections ?? {}))).toEqual(referenced)
    const candidate = otc?.sections.pregnancy_or_breast_feeding?.[0]
    expect(candidate?.id).toBe('pregnancy_or_breast_feeding:1')
    expect(candidate?.text.startsWith('If pregnant or breast-feeding')).toBe(true)
    expect(Object.keys(candidate ?? {}).sort()).toEqual(['id', 'lead_in', 'text'])
  })

  it('resolves the ingredients of a combination RxCUI', async () => {
    const data = await body('/api/labels/214181')

    expect(data.ingredients.map((i) => i.name)).toEqual(['acetaminophen', 'diphenhydramine'])
    expect(data.labels.map((l) => l.product_type)).toEqual(['otc'])
  })

  it('answers a non-numeric RxCUI with a 422 problem', async () => {
    const response = await get('/api/labels/advil')

    expect(response.status).toBe(422)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
  })

  it('answers an unknown RxCUI with a 404 problem', async () => {
    const response = await get('/api/labels/0')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(((await response.json()) as { detail: string }).detail).toBe(
      'No drug found for RxCUI 0.',
    )
  })

  it('answers a drug without any FDA label with a 404 problem', async () => {
    const openfda = new OpenFdaClient({
      baseUrl: 'https://x.test',
      fetch: mockFetch(() => json(404, { error: { code: 'NOT_FOUND' } })),
    })
    const response = await get('/api/labels/5640', { openfda })

    expect(response.status).toBe(404)
    expect(((await response.json()) as { detail: string }).detail).toBe(
      'No FDA label found for ibuprofen.',
    )
  })

  it('answers an upstream failure with a 502 problem that leaks nothing', async () => {
    const rxnorm = new RxNormClient({
      baseUrl: 'https://x.test',
      fetch: mockFetch(() => new Response('upstream secret stack trace', { status: 503 })),
    })
    const response = await get('/api/labels/5640', { rxnorm })

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    const text = await response.text()
    expect(JSON.parse(text).detail).toBe('A drug data source is unavailable. Try again later.')
    expect(text).not.toContain('secret')
  })

  it('exposes the lead-in of bullet candidates', async () => {
    const label = (await body('/api/labels/6809')).labels[0]
    const item = label?.sections.contraindications?.find(
      (c) => c.text === 'Hypersensitivity to metformin.',
    )

    expect(item?.lead_in?.endsWith('is contraindicated in patients with:')).toBe(true)
  })
})
