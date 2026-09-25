import { describe, expect, it } from 'vitest'
import { CATALOG, candidateSections } from '../src/catalog.ts'
import {
  buildRequest,
  chunkKey,
  estimateTokens,
  Judge,
  MAX_CHOICE_OPTIONS,
  NONE,
  questionKey,
  SHORTLIST_PER_CHUNK,
  STANCES,
} from '../src/judge.ts'
import { JudgeError } from '../src/problems.ts'
import { labelCandidates } from '../src/sentences.ts'
import { FakeJev, MODEL_VERSION } from './jev.ts'
import { ibuprofenOtc, longLabel, metforminRx, unanswerableLabel } from './labels.ts'

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function judge(jev: FakeJev | null): Judge {
  return new Judge(jev?.client() ?? null, 'jev-latest')
}

describe('buildRequest', () => {
  it('gives every catalog question a subject', () => {
    expect(CATALOG.every((q) => q.subject.trim())).toBe(true)
  })

  it('asks stance and evidence for every question with candidates', async () => {
    const label = await metforminRx()
    const request = await buildRequest(label)
    const asked = CATALOG.filter((q) => candidateSections(q.id, label).length > 0).map((q) => q.id)

    expect(Object.keys(request.asked)).toEqual(asked)
    expect(new Set(Object.keys(request.questions))).toEqual(
      new Set(asked.flatMap((q) => [questionKey(q, 'stance'), questionKey(q, 'evidence')])),
    )
  })

  it('offers the five fixed categories as stance options', async () => {
    const request = await buildRequest(await metforminRx())
    for (const questionId of Object.keys(request.asked)) {
      const criteria = request.questions[questionKey(questionId, 'stance')]?.criteria ?? {}
      expect(Object.keys(criteria)).toEqual([...STANCES])
      expect(Object.values(criteria).every(Boolean)).toBe(true)
    }
    expect(STANCES).toEqual([
      'warns_against',
      'caution',
      'dose_change',
      'no_known_issue',
      'not_mentioned',
    ])
  })

  it('offers candidate ids plus none as evidence options', async () => {
    const label = await metforminRx()
    const request = await buildRequest(label)
    for (const [questionId, candidates] of Object.entries(request.asked)) {
      const sections = candidateSections(questionId, label)
      const expected = labelCandidates(label, sections).map((c) => c.id)
      expect(candidates.map((c) => c.id)).toEqual(expected)
      const criteria = request.questions[questionKey(questionId, 'evidence')]?.criteria ?? {}
      expect(Object.keys(criteria)).toEqual([...expected, NONE])
    }
  })

  it('holds every candidate verbatim by id in the state', async () => {
    const request = await buildRequest(await metforminRx())
    const sections = request.state.drug_label.sections
    for (const candidates of Object.values(request.asked)) {
      for (const c of candidates) {
        const entry = sections[c.section]?.[c.id]
        if (c.lead_in === null) expect(entry).toBe(c.text)
        else expect(entry).toEqual({ lead_in: c.lead_in.text, text: c.text })
      }
    }
  })

  it('holds only sections some question uses in the state', async () => {
    const request = await buildRequest(await metforminRx())
    const used = new Set(Object.values(request.asked).flatMap((cs) => cs.map((c) => c.section)))

    expect(new Set(Object.keys(request.state.drug_label.sections))).toEqual(used)
  })

  it('names the subject and the sections to read in the instructions', async () => {
    const label = await metforminRx()
    const request = await buildRequest(label)
    const pregnancy = CATALOG.find((q) => q.id === 'pregnancy')
    for (const kind of ['stance', 'evidence'] as const) {
      const text = JSON.stringify(request.questions[questionKey('pregnancy', kind)]?.instructions)
      expect(text).toContain(pregnancy?.subject)
      for (const section of candidateSections('pregnancy', label)) {
        expect(text).toContain(`\`drug_label.sections.${section}\``)
      }
    }
  })

  it('counts unestablished safety in children as caution', async () => {
    const request = await buildRequest(await metforminRx())
    const children = JSON.stringify(request.questions[questionKey('children', 'stance')])
    expect(children).toContain('not been established')
    expect(children).toContain('`caution`')
    const pregnancy = JSON.stringify(request.questions[questionKey('pregnancy', 'stance')])
    expect(pregnancy).not.toContain('not been established')
  })

  it('skips a question without sections', async () => {
    const request = await buildRequest(await ibuprofenOtc())

    expect(request.skipped.boxed_warning).toBe('no_sections')
    expect(request.asked).not.toHaveProperty('boxed_warning')
  })

  it('splits evidence over the option limit into chunks, never truncating', async () => {
    const request = await buildRequest(longLabel(MAX_CHOICE_OPTIONS))
    const candidates = (request.asked.allergy ?? []).map((c) => c.id)

    expect(candidates.length).toBeGreaterThanOrEqual(MAX_CHOICE_OPTIONS)
    expect(request.skipped).not.toHaveProperty('allergy')
    // Chunking one question never drops an unrelated one.
    expect(request.asked).toHaveProperty('pregnancy')

    const chunks = request.evidenceChunks.allergy?.chunks ?? []
    expect(chunks).toHaveLength(2)
    expect(chunks.flat()).toEqual(candidates)
    expect(request.questions).not.toHaveProperty(questionKey('allergy', 'evidence'))
    chunks.forEach((chunk, n) => {
      const criteria = Object.keys(request.questions[chunkKey('allergy', n)]?.criteria ?? {})
      expect(criteria).toEqual([...chunk, NONE])
      expect(criteria.length).toBeLessThanOrEqual(MAX_CHOICE_OPTIONS)
    })
  })

  it('still asks stance when evidence is chunked', async () => {
    const request = await buildRequest(longLabel(MAX_CHOICE_OPTIONS))
    const stance = request.questions[questionKey('allergy', 'stance')]

    expect(Object.keys(stance?.criteria ?? {})).toEqual([...STANCES])
  })

  it('does not chunk evidence within the option limit', async () => {
    expect((await buildRequest(await metforminRx())).evidenceChunks).toEqual({})
  })

  it('keeps the prompt hash stable and tracks label text', async () => {
    const label = await metforminRx()
    const hash = (await buildRequest(label)).promptHash
    const changed = { ...label, sections: { ...label.sections, pregnancy: 'Changed text.' } }

    expect((await buildRequest(label)).promptHash).toBe(hash)
    expect((await buildRequest(changed)).promptHash).not.toBe(hash)
  })

  it('matches the pinned catalog prompt hashes', async () => {
    // Stored runs are keyed by these hashes. A change re-judges every stored label, so it
    // must be a deliberate prompt change, never a side effect of refactoring.
    const metformin = await metforminRx()
    expect((await buildRequest(metformin)).promptHash).toBe(
      '8e18faef81c01d94ab20679d7a26b30db147a073f073ec81101454f21ce4e3c3',
    )
    expect((await buildRequest(await ibuprofenOtc())).promptHash).toBe(
      'be40b80cdc9b414b04cc955c4f999293dfd6a80911b3415cd72695ebae42a2af',
    )
    expect((await buildRequest(metformin, 4_000)).promptHash).toBe(
      '45c0435c9e168f4b095d89a4c3c5ee7c2c0b5732e9972ea7091ad85cc5da1d8e',
    )
  })

  it('sends a label that fits as one part', async () => {
    const request = await buildRequest(await metforminRx())

    expect(request.parts).toHaveLength(1)
    expect(request.parts[0]?.state).toEqual(request.state)
    expect(request.parts[0]?.questions).toEqual(request.questions)
  })

  it('splits an oversized label by question under the budget', async () => {
    const budget = 12_000
    const request = await buildRequest(await metforminRx(), budget)
    expect(request.parts.length).toBeGreaterThan(1)

    const keys = request.parts.flatMap((part) => Object.keys(part.questions))
    expect(keys.sort()).toEqual(Object.keys(request.questions).sort())
    for (const part of request.parts) {
      expect(estimateTokens(part.state, part.questions)).toBeLessThanOrEqual(budget)
      const ids = new Set(Object.keys(part.questions).map((k) => k.slice(0, k.lastIndexOf('.'))))
      for (const id of ids) {
        expect(part.questions).toHaveProperty([questionKey(id, 'stance')])
        expect(part.questions).toHaveProperty([questionKey(id, 'evidence')])
      }
      const asked = new Map(Object.entries(request.asked))
      const used = new Set([...ids].flatMap((q) => (asked.get(q) ?? []).map((c) => c.section)))
      expect(new Set(Object.keys(part.state.drug_label.sections))).toEqual(used)
    }
  })

  it('skips a question too long for any part', async () => {
    const request = await buildRequest(await metforminRx(), 3_000)

    expect(request.skipped.kidney).toBe('too_long')
    expect(request.asked).not.toHaveProperty('kidney')
    expect(request.questions).not.toHaveProperty(questionKey('kidney', 'stance'))
    expect(request.asked).toHaveProperty('older_adults')
    expect(request.parts.every((p) => estimateTokens(p.state, p.questions) <= 3_000)).toBe(true)
  })

  it('covers how the label was split in the prompt hash', async () => {
    const label = await metforminRx()

    expect((await buildRequest(label, 12_000)).promptHash).not.toBe(
      (await buildRequest(label)).promptHash,
    )
  })

  it('gives a label with every question skipped no parts and a stable hash', async () => {
    const label = unanswerableLabel()
    const request = await buildRequest(label)

    expect(request.parts).toEqual([])
    expect(request.questions).toEqual({})
    expect(new Set(Object.keys(request.skipped))).toEqual(new Set(CATALOG.map((q) => q.id)))
    expect((await buildRequest(label)).promptHash).toBe(request.promptHash)
    expect(request.promptHash).toBe(await sha256('[]'))
  })
})

describe('Judge', () => {
  it('decides chunked evidence with a second request over a shortlist', async () => {
    const jev = new FakeJev()
    const request = await buildRequest(longLabel(MAX_CHOICE_OPTIONS))
    const result = await judge(jev).judge(request)

    expect(jev.requests).toHaveLength(request.parts.length + 1)
    const final = jev.requests.at(-1)
    const chunked = Object.keys(request.evidenceChunks)
    expect(new Set(Object.keys(final?.questions ?? {}))).toEqual(
      new Set(chunked.map((q) => questionKey(q, 'evidence'))),
    )

    // Each chunk contributes its most probable sentences, in label order, plus `none`.
    const chunks = request.evidenceChunks.allergy?.chunks ?? []
    const shortlist = chunks.flatMap((chunk) => chunk.slice(0, SHORTLIST_PER_CHUNK))
    const options = Object.keys(
      final?.questions[questionKey('allergy', 'evidence')]?.criteria ?? {},
    )
    expect(options).toEqual([...shortlist, NONE])
    const sections = final?.state.drug_label.sections ?? {}
    expect(new Set(Object.values(sections).flatMap((entries) => Object.keys(entries)))).toEqual(
      new Set(shortlist),
    )

    expect(new Set(Object.keys(result.distributions))).toEqual(
      new Set(
        Object.keys(request.asked).flatMap((q) => [
          questionKey(q, 'stance'),
          questionKey(q, 'evidence'),
        ]),
      ),
    )
    expect(result.distributions[questionKey('allergy', 'evidence')]?.choice).toBe(shortlist[0])
    expect(result.input_tokens).toBe(1234 * jev.requests.length)
  })

  it("follows each chunk's probabilities in the shortlist", async () => {
    const request = await buildRequest(longLabel(MAX_CHOICE_OPTIONS))
    const chunks = request.evidenceChunks.allergy?.chunks ?? []
    const favourites = new Map(chunks.map((chunk, n) => [chunkKey('allergy', n), chunk.at(-1)]))
    const jev = new FakeJev({ pick: (key, options) => favourites.get(key) ?? options[0] ?? '' })

    await judge(jev).judge(request)
    const final = jev.requests.at(-1)?.questions[questionKey('allergy', 'evidence')]?.criteria ?? {}
    for (const chunk of chunks) expect(final).toHaveProperty([chunk.at(-1) ?? ''])
  })

  it('still asks the shortlist when every chunk answers none', async () => {
    const jev = new FakeJev({
      pick: (_key, options) => (options.includes(NONE) ? NONE : (options[0] ?? '')),
    })
    const request = await buildRequest(longLabel(MAX_CHOICE_OPTIONS))
    const result = await judge(jev).judge(request)

    expect(result.distributions[questionKey('allergy', 'evidence')]?.choice).toBe(NONE)
    expect(jev.requests).toHaveLength(request.parts.length + 1)
  })

  it('sends all questions in one request', async () => {
    const jev = new FakeJev()
    const request = await buildRequest(await metforminRx())
    await judge(jev).judge(request)

    expect(jev.requests).toHaveLength(1)
    const body = jev.requests[0]
    expect(body?.model).toBe('jev-latest')
    expect(new Set(Object.keys(body?.questions ?? {}))).toEqual(
      new Set(Object.keys(request.questions)),
    )
    expect(body?.state).toEqual(request.state)
  })

  it('returns full distributions and usage', async () => {
    const request = await buildRequest(await metforminRx())
    const result = await judge(new FakeJev()).judge(request)

    expect(result.model_version).toBe(MODEL_VERSION)
    expect([result.input_tokens, result.output_tokens]).toEqual([1234, 56])
    expect(result.latency_ms).toBeGreaterThanOrEqual(0)
    expect(new Set(Object.keys(result.distributions))).toEqual(
      new Set(Object.keys(request.questions)),
    )
    const stance = result.distributions[questionKey('pregnancy', 'stance')]
    expect(stance?.choice).toBe('warns_against')
    expect(new Set(Object.keys(stance?.probabilities ?? {}))).toEqual(new Set(STANCES))
    expect(stance?.confidence).toBe(0.8)
  })

  it('fails cleanly without an API key', async () => {
    await expect(judge(null).judge(await buildRequest(await metforminRx()))).rejects.toBeInstanceOf(
      JudgeError,
    )
  })

  it('wraps API failures', async () => {
    const request = await buildRequest(await metforminRx())

    await expect(judge(new FakeJev({ status: 529 })).judge(request)).rejects.toBeInstanceOf(
      JudgeError,
    )
  })

  it('rejects a choice outside the options', async () => {
    const jev = new FakeJev({ pick: () => 'made_up' })

    await expect(judge(jev).judge(await buildRequest(await metforminRx()))).rejects.toBeInstanceOf(
      JudgeError,
    )
  })

  it('sends one call per part and merges the answers', async () => {
    const jev = new FakeJev()
    const request = await buildRequest(await metforminRx(), 12_000)
    const result = await judge(jev).judge(request)

    expect(jev.requests).toHaveLength(request.parts.length)
    expect(jev.requests.map((b) => new Set(Object.keys(b.questions)))).toEqual(
      request.parts.map((p) => new Set(Object.keys(p.questions))),
    )
    expect(new Set(Object.keys(result.distributions))).toEqual(
      new Set(Object.keys(request.questions)),
    )
    expect(result.input_tokens).toBe(1234 * request.parts.length)
    expect(result.output_tokens).toBe(56 * request.parts.length)
  })

  it('rejects a missing answer', async () => {
    const jev = new FakeJev({ drop: new Set([questionKey('pregnancy', 'evidence')]) })

    await expect(judge(jev).judge(await buildRequest(await metforminRx()))).rejects.toBeInstanceOf(
      JudgeError,
    )
  })
})
