import { MAX_QUESTION_CHARS, MIN_QUESTION_CHARS, STANCES } from '@rx-jev/contract'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Ingredient } from '@rx-jev/contract'
import { RxNormClient } from '../src/clients/rxnorm.ts'
import { ConfigSchema, readConfig } from '../src/config.ts'
import { buildCustomRequest, CUSTOM, NONE } from '../src/judge.ts'
import { PROBLEM_JSON } from '../src/problems.ts'
import { RateLimiter } from '../src/ratelimit.ts'
import {
  IBUPROFEN,
  memoryLimiter,
  METFORMIN,
  RXNORM_BASE,
  runs,
  type TestOverrides,
  testApp,
} from './helpers.ts'
import { FakeJev, MODEL_VERSION } from './jev.ts'
import { ibuprofenOtc } from './labels.ts'
import { rxnormFetch, unreachable } from './recorded.ts'

const GRAPEFRUIT = 'Can I drink grapefruit juice while taking this?'
const CLIENT = '203.0.113.7'

type AskBody = {
  rxcui: string
  label: { set_id: string; version: string; dailymed_url: string }
  model_version: string | null
  input_tokens: number | null
  output_tokens: number | null
  latency_ms: number | null
  answer: {
    question: string
    status: string
    reviewed: boolean
    confident: boolean
    stance: { probabilities: Record<string, number> } | null
    evidence: { choice: string; quote: unknown } | null
    candidates: number
    sections: string[]
  }
  sources: { openfda_requests: number }
}

async function ask(
  overrides: TestOverrides,
  rxcui: string,
  setId: string,
  question: string = GRAPEFRUIT,
): Promise<Response> {
  return testApp(overrides).request(
    `/api/labels/${rxcui}/ask`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': CLIENT },
      body: JSON.stringify({ set_id: setId, question }),
    },
    env,
  )
}

async function askBody(overrides: TestOverrides, question: string = GRAPEFRUIT): Promise<AskBody> {
  const label = await ibuprofenOtc()
  return (await (await ask(overrides, IBUPROFEN, label.set_id, question)).json()) as AskBody
}

describe('ask', () => {
  it('asks Jev live about the chosen label and stores nothing', async () => {
    const label = await ibuprofenOtc()
    const jev = new FakeJev()
    const response = await ask({ jev }, IBUPROFEN, label.set_id)

    expect(response.status).toBe(200)
    const body = (await response.json()) as AskBody
    expect(body.rxcui).toBe(IBUPROFEN)
    expect(body.label.set_id).toBe(label.set_id)
    expect(body.label.version).toBe(label.version)
    expect(body.label.dailymed_url.endsWith(label.set_id)).toBe(true)
    expect(body.model_version).toBe(MODEL_VERSION)
    // One label, one request; the other canonical label is not asked.
    expect(jev.requests).toHaveLength(1)
    expect(await runs(env)).toBe(0)
  })

  it("sends the reader's question", async () => {
    const label = await ibuprofenOtc()
    const jev = new FakeJev()
    await ask({ jev }, IBUPROFEN, label.set_id)
    const expected = (await buildCustomRequest(label, GRAPEFRUIT)).parts[0]

    expect(jev.requests[0]?.state).toEqual(expected?.state)
    expect(new Set(Object.keys(jev.requests[0]?.questions ?? {}))).toEqual(
      new Set(Object.keys(expected?.questions ?? {})),
    )
    for (const question of Object.values(jev.requests[0]?.questions ?? {})) {
      expect(question.instructions.reader_question).toBe(GRAPEFRUIT)
    }
  })

  it('is never reviewed and uses the fixed categories', async () => {
    const answer = (await askBody({ jev: new FakeJev() })).answer

    expect(answer.question).toBe(GRAPEFRUIT)
    expect(answer.status).toBe('judged')
    expect(answer.reviewed).toBe(false)
    expect(Object.keys(answer.stance?.probabilities ?? {})).toEqual([...STANCES])
  })

  it('quotes a verbatim candidate', async () => {
    const label = await ibuprofenOtc()
    const candidate = (await buildCustomRequest(label, GRAPEFRUIT)).asked[CUSTOM]?.[3]
    if (!candidate) throw new Error('No candidate')
    const jev = new FakeJev({
      pick: (_key, options) => (options.includes(candidate.id) ? candidate.id : (options[0] ?? '')),
    })
    const evidence = (await askBody({ jev })).answer.evidence

    expect(evidence?.choice).toBe(candidate.id)
    expect(evidence?.quote).toEqual({
      section: candidate.section,
      text: candidate.text,
      lead_in: candidate.lead_in?.text ?? null,
    })
  })

  it('calls Jev again for every ask', async () => {
    const label = await ibuprofenOtc()
    const jev = new FakeJev()
    await ask({ jev }, IBUPROFEN, label.set_id)
    await ask({ jev }, IBUPROFEN, label.set_id)

    expect(jev.requests).toHaveLength(2)
  })

  it.each([
    [0.95, true],
    [0.85, false],
  ])('with confidence %s, confident is %s', async (confidence, expected) => {
    const answer = (await askBody({ jev: new FakeJev({ confidence: () => confidence }) })).answer

    expect(answer.confident).toBe(expected)
  })

  it('never calls evidence of none confident', async () => {
    const jev = new FakeJev({
      pick: (_key, options) => (options.includes(NONE) ? NONE : (options[0] ?? '')),
    })
    const answer = (await askBody({ jev, config: readConfig({ DISPLAY_MIN_CONFIDENCE: '0.5' }) }))
      .answer

    expect(answer.evidence?.quote).toBeNull()
    expect(answer.confident).toBe(false)
  })

  it('answers a set_id that is not a canonical label with 404', async () => {
    const jev = new FakeJev()
    const response = await ask({ jev }, METFORMIN, 'not-a-label')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(jev.requests).toEqual([])
  })

  it('answers a Jev failure with 503', async () => {
    const label = await ibuprofenOtc()
    const response = await ask({ jev: new FakeJev({ status: 529 }) }, IBUPROFEN, label.set_id)

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
  })

  it('answers a blank question with 422', async () => {
    const label = await ibuprofenOtc()
    const jev = new FakeJev()
    const response = await ask({ jev }, IBUPROFEN, label.set_id, '   ')

    expect(response.status).toBe(422)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(jev.requests).toEqual([])
  })

  it.each(['ab', 'x'.repeat(MAX_QUESTION_CHARS + 1)])(
    'limits the question length: %s',
    async (q) => {
      const label = await ibuprofenOtc()
      const jev = new FakeJev()
      const response = await ask({ jev }, IBUPROFEN, label.set_id, q)

      expect(response.status).toBe(422)
      expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
      expect(jev.requests).toEqual([])
    },
  )

  it('counts characters, not UTF-16 units, toward the length limit', async () => {
    const label = await ibuprofenOtc()
    const response = await ask({ jev: new FakeJev() }, IBUPROFEN, label.set_id, '💊'.repeat(150))

    expect(response.status).toBe(200)
  })

  it('keeps the question length limits', () => {
    expect([MIN_QUESTION_CHARS, MAX_QUESTION_CHARS]).toEqual([3, 200])
  })

  it('asks a question at the length limit', async () => {
    const label = await ibuprofenOtc()
    const response = await ask(
      { jev: new FakeJev() },
      IBUPROFEN,
      label.set_id,
      'x'.repeat(MAX_QUESTION_CHARS),
    )

    expect(response.status).toBe(200)
  })

  it('answers asks over the rate limit with 429 without calling Jev', async () => {
    const label = await ibuprofenOtc()
    const jev = new FakeJev()
    const askLimiter = memoryLimiter(new RateLimiter([{ count: 2, seconds: 60 }]))
    const statuses = []
    for (let i = 0; i < 2; i++) {
      statuses.push((await ask({ jev, askLimiter }, IBUPROFEN, label.set_id)).status)
    }
    const response = await ask({ jev, askLimiter }, IBUPROFEN, label.set_id)

    expect(statuses).toEqual([200, 200])
    expect(response.status).toBe(429)
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON)
    const wait = Number(response.headers.get('retry-after'))
    expect(wait).toBeGreaterThanOrEqual(1)
    expect(wait).toBeLessThanOrEqual(60)
    expect(((await response.json()) as { detail: string }).detail).toContain('Try again')
    expect(jev.requests).toHaveLength(2)
  })

  it('does not count invalid asks toward the limit', async () => {
    const label = await ibuprofenOtc()
    const askLimiter = memoryLimiter(new RateLimiter([{ count: 1, seconds: 60 }]))
    await ask({ jev: new FakeJev(), askLimiter }, IBUPROFEN, label.set_id, 'ab')
    const response = await ask({ jev: new FakeJev(), askLimiter }, IBUPROFEN, label.set_id)

    expect(response.status).toBe(200)
  })

  it('does not count asks about an unknown label or drug toward the limit', async () => {
    const label = await ibuprofenOtc()
    const askLimiter = memoryLimiter(new RateLimiter([{ count: 1, seconds: 60 }]))
    const jev = new FakeJev()

    expect((await ask({ jev, askLimiter }, IBUPROFEN, 'not-a-label')).status).toBe(404)
    expect((await ask({ jev, askLimiter }, '0', label.set_id)).status).toBe(404)
    expect((await ask({ jev, askLimiter }, IBUPROFEN, label.set_id)).status).toBe(200)
  })

  it('answers a spent limit with 429 before any upstream call', async () => {
    const label = await ibuprofenOtc()
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }])
    limiter.hit(CLIENT)
    const response = await ask(
      {
        jev: new FakeJev(),
        askLimiter: memoryLimiter(limiter),
        rxnorm: new RxNormClient({ baseUrl: RXNORM_BASE, fetch: unreachable() }),
      },
      IBUPROFEN,
      label.set_id,
    )

    expect(response.status).toBe(429)
  })

  it('holds its slot during the upstream lookup', async () => {
    // Concurrent asks must not all pass the limit and then all call RxNorm and openFDA.
    const label = await ibuprofenOtc()
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }])
    const held: (number | null)[] = []

    class Checking extends RxNormClient {
      override async ingredientsOf(rxcui: string): Promise<Ingredient[]> {
        held.push(limiter.hit(CLIENT))
        return super.ingredientsOf(rxcui)
      }
    }

    const response = await ask(
      {
        jev: new FakeJev(),
        askLimiter: memoryLimiter(limiter),
        rxnorm: new Checking({ baseUrl: RXNORM_BASE, fetch: rxnormFetch() }),
      },
      IBUPROFEN,
      label.set_id,
    )

    expect(response.status).toBe(200)
    expect(held.length).toBeGreaterThan(0)
    expect(held[0]).not.toBeNull()
  })

  it('gives back only its own slot on a 404', async () => {
    let now = 1_000
    const limiter = new RateLimiter([{ count: 2, seconds: 60 }], () => now)

    class Overlapping extends RxNormClient {
      override async ingredientsOf(rxcui: string): Promise<Ingredient[]> {
        // A later ask from the same client takes a slot while this one is looking up.
        now += 10
        expect(limiter.hit(CLIENT)).toBeNull()
        return super.ingredientsOf(rxcui)
      }
    }

    const response = await ask(
      {
        jev: new FakeJev(),
        askLimiter: memoryLimiter(limiter),
        rxnorm: new Overlapping({ baseUrl: RXNORM_BASE, fetch: rxnormFetch() }),
      },
      IBUPROFEN,
      'not-a-label',
    )
    expect(response.status).toBe(404)

    // The later slot (at 1010) is still held; the 404's own slot (at 1000) is gone.
    expect(limiter.hit(CLIENT)).toBeNull()
    expect(limiter.hit(CLIENT)).toBeCloseTo(60)
  })

  it.each(['ASK_PER_MINUTE', 'ASK_PER_DAY'])('requires %s to allow at least one', (field) => {
    expect(ConfigSchema.safeParse({ [field]: '0' }).success).toBe(false)
  })

  it('limits each client to 5 asks a minute and 50 a day by default', () => {
    const config = readConfig({})

    expect([config.askPerMinute, config.askPerDay]).toEqual([5, 50])
  })
})

describe('the ask trace', () => {
  it('reports the live run and the sources', async () => {
    const label = await ibuprofenOtc()
    const body = await askBody({ jev: new FakeJev() })
    const candidates = (await buildCustomRequest(label, GRAPEFRUIT)).asked[CUSTOM] ?? []

    expect([body.input_tokens, body.output_tokens]).toEqual([1234, 56])
    expect(body.latency_ms).toBeGreaterThanOrEqual(0)
    expect(body.sources.openfda_requests).toBe(2)
    expect(body.answer.candidates).toBe(candidates.length)
    expect(body.answer.sections).toEqual([...new Set(candidates.map((c) => c.section))])
  })
})
