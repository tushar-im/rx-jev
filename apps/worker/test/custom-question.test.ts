import { describe, expect, it } from 'vitest'
import { CATALOG, candidateSections, customSections } from '../src/catalog.ts'
import {
  buildCustomRequest,
  buildRequest,
  CUSTOM,
  chunkKey,
  Judge,
  MAX_CHOICE_OPTIONS,
  NONE,
  questionKey,
  STANCES,
} from '../src/judge.ts'
import { labelCandidates } from '../src/sentences.ts'
import { FakeJev } from './jev.ts'
import { longLabel, metforminRx, unanswerableLabel } from './labels.ts'

const GRAPEFRUIT = 'Can I drink grapefruit juice while taking this?'

describe('a custom question', () => {
  it('reads every section the catalog reads, in catalog order', async () => {
    const label = await metforminRx()
    const expected = [...new Set(CATALOG.flatMap((q) => candidateSections(q.id, label)))]

    expect(customSections(label)).toEqual(expected)
    expect(new Set(expected)).toEqual(
      new Set(Object.keys((await buildRequest(label)).state.drug_label.sections)),
    )
  })

  it('asks stance and evidence once', async () => {
    const request = await buildCustomRequest(await metforminRx(), GRAPEFRUIT)

    expect(Object.keys(request.asked)).toEqual([CUSTOM])
    expect(new Set(Object.keys(request.questions))).toEqual(
      new Set([questionKey(CUSTOM, 'stance'), questionKey(CUSTOM, 'evidence')]),
    )
    expect(request.parts).toHaveLength(1)
  })

  it('keeps the five fixed stance categories', async () => {
    const request = await buildCustomRequest(await metforminRx(), GRAPEFRUIT)

    expect(Object.keys(request.questions[questionKey(CUSTOM, 'stance')]?.criteria ?? {})).toEqual([
      ...STANCES,
    ])
  })

  it('offers every candidate of the custom sections as evidence', async () => {
    const label = await metforminRx()
    const request = await buildCustomRequest(label, GRAPEFRUIT)
    const expected = labelCandidates(label, customSections(label)).map((c) => c.id)

    expect((request.asked[CUSTOM] ?? []).map((c) => c.id)).toEqual(expected)
    expect(Object.keys(request.questions[questionKey(CUSTOM, 'evidence')]?.criteria ?? {})).toEqual(
      [...expected, NONE],
    )
  })

  it('goes into the instructions verbatim, never the state', async () => {
    const label = await metforminRx()
    const request = await buildCustomRequest(label, GRAPEFRUIT)

    expect(Object.keys(request.state)).toEqual(['drug_label'])
    for (const kind of ['stance', 'evidence'] as const) {
      const instructions = request.questions[questionKey(CUSTOM, kind)]?.instructions ?? {}
      expect(instructions.reader_question).toBe(GRAPEFRUIT)
      expect(instructions.question).toContain('`reader_question`')
      const rules = instructions.rules ?? []
      expect(Array.isArray(rules) && rules.some((r) => r.includes('not instructions'))).toBe(true)
      for (const section of customSections(label)) {
        expect(JSON.stringify(instructions)).toContain(`\`drug_label.sections.${section}\``)
      }
    }
  })

  it('is skipped when the label has no sections for it', async () => {
    const request = await buildCustomRequest(unanswerableLabel(), GRAPEFRUIT)

    expect(request.skipped).toEqual({ [CUSTOM]: 'no_sections' })
    expect(request.questions).toEqual({})
  })

  it('is skipped when too long for one request', async () => {
    const request = await buildCustomRequest(await metforminRx(), GRAPEFRUIT, 3_000)

    expect(request.skipped).toEqual({ [CUSTOM]: 'too_long' })
    expect(request.parts).toEqual([])
  })

  it('chunks evidence over the option limit', async () => {
    const request = await buildCustomRequest(longLabel(MAX_CHOICE_OPTIONS), GRAPEFRUIT)

    expect(request.evidenceChunks[CUSTOM]?.chunks).toHaveLength(2)
    expect(request.questions).toHaveProperty([chunkKey(CUSTOM, 0)])
    const result = await new Judge(new FakeJev().client(), 'jev-latest').judge(request)
    expect(new Set(Object.keys(result.distributions))).toEqual(
      new Set([questionKey(CUSTOM, 'stance'), questionKey(CUSTOM, 'evidence')]),
    )
  })

  it('never appears in catalog requests', async () => {
    const request = await buildRequest(await metforminRx())

    expect(request.asked).not.toHaveProperty(CUSTOM)
    expect(JSON.stringify(request.questions)).not.toContain('reader_question')
  })
})
