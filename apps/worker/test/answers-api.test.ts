import { STANCES } from '@rx-jev/contract'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../src/catalog.ts'
import { readConfig } from '../src/config.ts'
import { buildRequest, MAX_CHOICE_OPTIONS, NONE } from '../src/judge.ts'
import { PROBLEM_JSON } from '../src/problems.ts'
import { IBUPROFEN, METFORMIN, OneLabel, runs, type TestOverrides, testApp } from './helpers.ts'
import { FakeJev, MODEL_VERSION } from './jev.ts'
import { ibuprofenOtc, labelWith, longText, metforminRx } from './labels.ts'

type AnswerBody = {
  question_id: string
  status: string
  reviewed: boolean
  confident: boolean
  stance: { choice: string; probabilities: Record<string, number> } | null
  evidence: {
    choice: string
    probability: number
    quote: { section: string; text: string; lead_in: string | null } | null
  } | null
  candidates: number
  sections: string[]
}

type LabelBody = Record<string, unknown> & {
  overview: unknown
  set_id: string
  product_type: string
  model_version: string | null
  judged_at: string | null
  fresh: boolean
  answers: AnswerBody[]
}

type Body = { labels: LabelBody[]; sources: Record<string, unknown> } & Record<string, unknown>

async function answers(rxcui: string, overrides: TestOverrides): Promise<Response> {
  return testApp(overrides).request(`/api/labels/${rxcui}/answers`, {}, env)
}

async function body(rxcui: string, overrides: TestOverrides): Promise<Body> {
  return (await (await answers(rxcui, overrides)).json()) as Body
}

async function firstLabel(rxcui: string, overrides: TestOverrides): Promise<LabelBody> {
  const label = (await body(rxcui, overrides)).labels[0]
  if (!label) throw new Error('No label')
  return label
}

function withoutTrace(data: Body): unknown {
  const { sources: _sources, ...rest } = data
  return { ...rest, labels: data.labels.map(({ fresh: _fresh, ...label }) => label) }
}

describe('answers', () => {
  it('judges each label once on a miss and stores it', async () => {
    const jev = new FakeJev()
    const response = await answers(IBUPROFEN, { jev })

    expect(response.status).toBe(200)
    const data = (await response.json()) as Body
    expect(data.labels.map((l) => l.product_type)).toEqual(['otc', 'prescription'])
    expect(jev.requests).toHaveLength(2)
    expect(await runs(env)).toBe(2)
    expect(data.labels.every((l) => l.model_version === MODEL_VERSION)).toBe(true)
  })

  it('serves a hit from the store without calling Jev', async () => {
    const jev = new FakeJev()
    const first = await body(METFORMIN, { jev })
    const second = await body(METFORMIN, { jev })

    expect(jev.requests).toHaveLength(1)
    // Everything but the per-request trace must match: `fresh` and the source timings
    // describe this request, not the answers.
    expect(withoutTrace(second)).toEqual(withoutTrace(first))
  })

  it('answers every catalog question in order, unreviewed', async () => {
    const label = await firstLabel(METFORMIN, { jev: new FakeJev() })

    expect(label.answers.map((a) => a.question_id)).toEqual(CATALOG.map((q) => q.id))
    expect(label.answers.every((a) => a.reviewed === false)).toBe(true)
  })

  it('carries label provenance', async () => {
    const label = await firstLabel(METFORMIN, { jev: new FakeJev() })

    for (const field of ['set_id', 'version', 'effective_time', 'dailymed_url']) {
      expect(label[field]).toBeTruthy()
    }
  })

  it('keeps all five stance categories apart', async () => {
    const stance = (await firstLabel(METFORMIN, { jev: new FakeJev() })).answers[0]?.stance

    expect(stance?.choice).toBe('warns_against')
    expect(Object.keys(stance?.probabilities ?? {})).toEqual([...STANCES])
  })

  it('does not judge a question without sections', async () => {
    const otc = await firstLabel(IBUPROFEN, { jev: new FakeJev() })
    const boxed = otc.answers.find((a) => a.question_id === 'boxed_warning')

    expect(boxed?.status).toBe('no_sections')
    expect(boxed?.stance).toBeNull()
    expect(boxed?.evidence).toBeNull()
  })

  it('quotes the evidence verbatim with its lead-in', async () => {
    const label = await metforminRx()
    const request = await buildRequest(label)
    const [questionId, candidate] =
      Object.entries(request.asked)
        .flatMap(([q, cs]) => (cs ?? []).map((c) => [q, c] as const))
        .find(([, c]) => c.lead_in !== null) ?? []
    if (!candidate) throw new Error('No candidate with a lead-in')
    const jev = new FakeJev({
      pick: (_key, options) => (options.includes(candidate.id) ? candidate.id : (options[0] ?? '')),
    })

    const served = await firstLabel(METFORMIN, { jev })
    const answer = served.answers.find((a) => a.question_id === questionId)
    expect(answer?.status).toBe('judged')
    expect(answer?.evidence?.choice).toBe(candidate.id)
    expect(answer?.evidence?.probability).toBe(0.9)
    expect(answer?.evidence?.quote).toEqual({
      section: candidate.section,
      text: candidate.text,
      lead_in: candidate.lead_in?.text ?? null,
    })
    expect(label.sections[candidate.section]).toContain(candidate.text)
  })

  it('gives evidence of none no quote', async () => {
    const jev = new FakeJev({
      pick: (_key, options) => (options.includes(NONE) ? NONE : (options[0] ?? '')),
    })
    const evidence = (await firstLabel(METFORMIN, { jev })).answers[0]?.evidence

    expect(evidence?.choice).toBe(NONE)
    expect(evidence?.quote).toBeNull()
  })

  it('answers a Jev failure with 503 and stores nothing', async () => {
    const response = await answers(IBUPROFEN, { jev: new FakeJev({ status: 529 }) })

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    const text = await response.text()
    expect(JSON.parse(text).status).toBe(503)
    expect(text).not.toContain('529')
    expect(await runs(env)).toBe(0)
  })

  it('stores no earlier label either when a later label fails', async () => {
    class FailsSecond extends FakeJev {
      override async handle(init: RequestInit | undefined): Promise<Response> {
        this.status = this.requests.length === 0 ? 200 : 529
        return super.handle(init)
      }
    }
    const jev = new FailsSecond()
    const response = await answers(IBUPROFEN, { jev })

    expect(jev.requests).toHaveLength(2)
    expect(response.status).toBe(503)
    expect(await runs(env)).toBe(0)
  })

  it('answers a missing API key with 503', async () => {
    const response = await answers(METFORMIN, { jev: null })

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
  })

  it('serves a label with every question skipped without Jev', async () => {
    const metformin = await metforminRx()
    const label = {
      ...metformin,
      sections: { indications_and_usage: metformin.sections.indications_and_usage ?? '' },
    }
    const jev = new FakeJev()
    const response = await answers(METFORMIN, { jev, openfda: new OneLabel(label) })

    expect(response.status).toBe(200)
    const served = ((await response.json()) as Body).labels
    expect(served).toHaveLength(1)
    const only = served[0]
    expect(only?.set_id).toBe(label.set_id)
    expect(only?.model_version).toBeNull()
    expect(only?.judged_at).toBeNull()
    expect(only?.answers.map((a) => a.question_id)).toEqual(CATALOG.map((q) => q.id))
    for (const answer of only?.answers ?? []) {
      expect(['no_sections', 'too_long']).toContain(answer.status)
      expect(answer.stance).toBeNull()
      expect(answer.evidence).toBeNull()
      expect(answer.reviewed).toBe(false)
    }
    expect(jev.requests).toEqual([])
    expect(await runs(env)).toBe(0)
  })

  it('judges a question with more sentences than one Choice holds', async () => {
    const metformin = await metforminRx()
    const label = {
      ...metformin,
      sections: { ...metformin.sections, contraindications: longText(MAX_CHOICE_OPTIONS) },
    }
    const request = await buildRequest(label)
    const questionId = Object.keys(request.evidenceChunks)[0]
    const jev = new FakeJev()

    const response = await answers(METFORMIN, { jev, openfda: new OneLabel(label) })

    expect(response.status).toBe(200)
    const served = ((await response.json()) as Body).labels[0]
    const answer = served?.answers.find((a) => a.question_id === questionId)
    expect(answer?.status).toBe('judged')
    expect(answer?.stance).not.toBeNull()
    const quote = answer?.evidence?.quote
    expect(new Map(Object.entries(label.sections)).get(quote?.section ?? '')).toContain(quote?.text)
    expect(jev.requests).toHaveLength(request.parts.length + 1)
  })

  it('never calls answers below the display threshold confident', async () => {
    // FakeJev answers with confidence 0.8, under the 0.9 set at Gate 1.
    const label = await firstLabel(METFORMIN, { jev: new FakeJev() })

    expect(label.answers.length).toBeGreaterThan(0)
    expect(label.answers.every((a) => a.confident === false)).toBe(true)
  })

  it('calls answers confident when both confidences reach the threshold', async () => {
    const label = await firstLabel(METFORMIN, {
      jev: new FakeJev(),
      config: readConfig({ DISPLAY_MIN_CONFIDENCE: '0.8' }),
    })
    const judged = label.answers.filter((a) => a.status === 'judged')
    const skipped = label.answers.filter((a) => a.status !== 'judged')

    expect(judged.length).toBeGreaterThan(0)
    expect(judged.every((a) => a.confident)).toBe(true)
    expect(skipped.every((a) => !a.confident)).toBe(true)
  })

  it.each([
    [0.95, 0.95, true],
    [0.95, 0.85, false],
    [0.85, 0.95, false],
    [0.9, 0.9, true],
  ])('with stance %s and evidence %s, confident is %s', async (stance, evidence, expected) => {
    const jev = new FakeJev({ confidence: (key) => (key.endsWith('.stance') ? stance : evidence) })
    const judged = (await firstLabel(METFORMIN, { jev })).answers.filter(
      (a) => a.status === 'judged',
    )

    expect(judged.length).toBeGreaterThan(0)
    expect(judged.every((a) => a.confident === expected)).toBe(true)
  })

  it('never calls evidence of none confident', async () => {
    const jev = new FakeJev({
      pick: (_key, options) => (options.includes(NONE) ? NONE : (options[0] ?? '')),
    })
    const label = await firstLabel(METFORMIN, {
      jev,
      config: readConfig({ DISPLAY_MIN_CONFIDENCE: '0.8' }),
    })
    const judged = label.answers.filter((a) => a.status === 'judged')

    expect(judged.length).toBeGreaterThan(0)
    expect(judged.every((a) => a.evidence?.choice === NONE)).toBe(true)
    expect(judged.every((a) => !a.confident)).toBe(true)
  })

  it('uses the Gate 1 display threshold by default', () => {
    expect(readConfig({}).displayMinConfidence).toBe(0.9)
  })

  it('answers an unknown RxCUI with a 404 problem without calling Jev', async () => {
    const jev = new FakeJev()
    const response = await answers('0', { jev })

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(jev.requests).toEqual([])
  })
})

describe('the answers trace', () => {
  it('reports the sources behind the lookup', async () => {
    const sources = (await body(IBUPROFEN, { jev: new FakeJev() })).sources

    expect(sources.openfda_requests).toBe(2)
    expect(sources.matches).toEqual({
      otc: { total: 831, original_packager: true },
      prescription: { total: 47, original_packager: true },
    })
    expect(sources.rxnorm_ms).toBeGreaterThanOrEqual(0)
    expect(sources.openfda_ms).toBeGreaterThanOrEqual(0)
  })

  it('reports a label judged now as fresh', async () => {
    const label = await firstLabel(METFORMIN, { jev: new FakeJev() })

    expect(label.fresh).toBe(true)
    expect([label.input_tokens, label.output_tokens]).toEqual([1234, 56])
    expect(label.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('keeps the run of a label from the store but not as fresh', async () => {
    const jev = new FakeJev()
    await body(METFORMIN, { jev })
    const label = await firstLabel(METFORMIN, { jev })

    expect(jev.requests).toHaveLength(1)
    expect(label.fresh).toBe(false)
    expect([label.input_tokens, label.output_tokens]).toEqual([1234, 56])
  })

  it('gives a label never sent to Jev no run', async () => {
    const metformin = await metforminRx()
    const label = {
      ...metformin,
      sections: { indications_and_usage: metformin.sections.indications_and_usage ?? '' },
    }
    const served = await firstLabel(METFORMIN, { jev: new FakeJev(), openfda: new OneLabel(label) })

    expect(served.fresh).toBe(false)
    expect([served.input_tokens, served.output_tokens, served.latency_ms]).toEqual([
      null,
      null,
      null,
    ])
  })

  it('says how many sentences Jev chose from for each answer', async () => {
    const request = await buildRequest(await metforminRx())
    const asked = new Map(Object.entries(request.asked))
    const label = await firstLabel(METFORMIN, { jev: new FakeJev() })

    for (const answer of label.answers) {
      const candidates = asked.get(answer.question_id) ?? []
      expect(answer.candidates).toBe(candidates.length)
      expect(answer.sections).toEqual([...new Set(candidates.map((c) => c.section))])
    }
  })

  it('offers no sentences for a skipped answer', async () => {
    const otc = await firstLabel(IBUPROFEN, { jev: new FakeJev() })
    const boxed = otc.answers.find((a) => a.question_id === 'boxed_warning')

    expect(boxed?.status).toBe('no_sections')
    expect([boxed?.candidates, boxed?.sections]).toEqual([0, []])
  })

  it('always gives judged_at a UTC offset', async () => {
    // Browsers read a time without a timezone as local time and can show the wrong day.
    const jev = new FakeJev()
    const fresh = await firstLabel(METFORMIN, { jev })
    const stored = await firstLabel(METFORMIN, { jev })

    for (const label of [fresh, stored]) expect(label.judged_at).toMatch(/(Z|\+00:00)$/)
  })
})

describe('the label overview', () => {
  it('quotes the boxed warning, uses and strengths of a prescription label verbatim', async () => {
    const label = await metforminRx()
    const served = await firstLabel(METFORMIN, { jev: new FakeJev() })

    // The label's own heading becomes the caption; the text is the rest, verbatim.
    const after = (text: string | undefined, heading: string) =>
      (text ?? '').slice(heading.length).replace(/^\s+/, '')
    expect(served.overview).toEqual({
      boxed_warning: {
        section: 'boxed_warning',
        heading: null,
        text: label.sections.boxed_warning,
      },
      purpose: null,
      uses: {
        section: 'indications_and_usage',
        heading: '1 INDICATIONS AND USAGE',
        text: after(label.sections.indications_and_usage, '1 INDICATIONS AND USAGE'),
      },
      strengths: {
        section: 'dosage_forms_and_strengths',
        heading: '3 DOSAGE FORMS AND STRENGTHS',
        text: after(label.sections.dosage_forms_and_strengths, '3 DOSAGE FORMS AND STRENGTHS'),
      },
    })
  })

  it('quotes the purpose, uses and active ingredient of an OTC label', async () => {
    const label = await ibuprofenOtc()
    const served = await firstLabel(IBUPROFEN, { jev: new FakeJev() })

    const after = (text: string | undefined, heading: string) =>
      (text ?? '').slice(heading.length).replace(/^\s+/, '')
    expect(served.overview).toEqual({
      boxed_warning: null,
      purpose: {
        section: 'purpose',
        heading: 'Purposes',
        text: after(label.sections.purpose, 'Purposes'),
      },
      uses: {
        section: 'indications_and_usage',
        heading: 'Uses',
        text: after(label.sections.indications_and_usage, 'Uses'),
      },
      strengths: {
        section: 'active_ingredient',
        heading: 'Active ingredient (in each tablet)',
        text: after(label.sections.active_ingredient, 'Active ingredient (in each tablet)'),
      },
    })
  })

  it('shows OTC sections only on labels with the OTC layout', async () => {
    // Prescription layout: no Drug Facts sections, so purpose and active ingredient are not
    // its overview even if present.
    const label = labelWith(
      { purpose: 'Purpose X', active_ingredient: 'Active Y', indications_and_usage: 'Uses Z' },
      'prescription',
    )
    const served = await firstLabel(METFORMIN, { jev: new FakeJev(), openfda: new OneLabel(label) })

    expect(served.overview).toEqual({
      boxed_warning: null,
      purpose: null,
      uses: { section: 'indications_and_usage', heading: 'Uses', text: 'Z' },
      strengths: null,
    })
  })

  it('reads a prescription label with the OTC layout as OTC, as the catalog does', async () => {
    const label = labelWith(
      {
        do_not_use: 'Do not use if allergic.',
        purpose: 'Purpose Antihistamine',
        active_ingredient: 'Active ingredient Loratadine 10 mg',
        dosage_forms_and_strengths: '3 DOSAGE FORMS AND STRENGTHS Tablets.',
      },
      'prescription',
    )
    const served = await firstLabel(METFORMIN, { jev: new FakeJev(), openfda: new OneLabel(label) })

    expect(served.overview).toMatchObject({
      purpose: { section: 'purpose', heading: 'Purpose', text: 'Antihistamine' },
      strengths: {
        section: 'active_ingredient',
        heading: 'Active ingredient',
        text: 'Loratadine 10 mg',
      },
    })
  })

  it('leaves out sections the label does not have or leaves blank', async () => {
    const metformin = await metforminRx()
    const label = { ...metformin, sections: { boxed_warning: '  ', warnings: 'W.' } }
    const served = await firstLabel(METFORMIN, { jev: new FakeJev(), openfda: new OneLabel(label) })

    expect(served.overview).toEqual({
      boxed_warning: null,
      purpose: null,
      uses: null,
      strengths: null,
    })
  })
})
