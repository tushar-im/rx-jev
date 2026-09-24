import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  confidenceBand,
  flags,
  labelRows,
  REVIEW_COLUMNS,
  type ReviewRow,
  selectRows,
  writeCsv,
  writeJson,
} from '../../scripts/lib/review.ts'
import { type JudgedLabel, judgeLabels } from '../../src/answering.ts'
import { candidateSections, getQuestion } from '../../src/catalog.ts'
import type { Label } from '../../src/clients/openfda.ts'
import { Judge, NONE } from '../../src/judge.ts'
import { Store } from '../../src/store.ts'
import { FakeJev } from '../jev.ts'
import { ibuprofenOtc, metforminRx } from '../labels.ts'
import { tempD1 } from './d1.ts'

let d1: Awaited<ReturnType<typeof tempD1>>

beforeAll(async () => {
  d1 = await tempD1()
}, 120_000)
afterAll(async () => d1?.dispose())
beforeEach(async () => d1.clear())

async function judged(label: Label): Promise<JudgedLabel> {
  const [result] = await judgeLabels(
    [label],
    new Judge(new FakeJev().client(), 'jev-latest'),
    new Store(d1.db),
  )
  if (!result) throw new Error('Not judged')
  return result
}

function row(
  n: number,
  stance = 'caution',
  stanceConf = 0.99,
  evidence = 's1',
  evidenceConf = 0.95,
): ReviewRow {
  return {
    row_id: `set:${n}`,
    drug: 'metformin',
    product_type: 'prescription',
    set_id: 'set',
    version: '1',
    dailymed_url: 'https://dailymed.test',
    question_id: 'kidney',
    title: 'Kidney disease',
    subject: 'kidney disease',
    sections: ['warnings'],
    stance,
    stance_confidence: stanceConf,
    evidence,
    evidence_confidence: evidenceConf,
    quote_section: evidence === NONE ? null : 'warnings',
    quote_lead_in: null,
    quote_text: evidence === NONE ? null : 'A sentence.',
    reasons: [],
  }
}

describe('review rows', () => {
  it('has one row per judged question with its quote', async () => {
    const label = await metforminRx()
    const j = await judged(label)
    const rows = labelRows('metformin', j)

    expect(rows.map((r) => r.question_id)).toEqual(Object.keys(j.request.asked))
    const first = rows[0]
    if (!first) throw new Error('No rows')
    expect(first.row_id).toBe(`${label.set_id}:${first.question_id}`)
    expect([first.drug, first.set_id, first.version]).toEqual([
      'metformin',
      label.set_id,
      label.version,
    ])
    expect(first.sections).toEqual(candidateSections(first.question_id, label))
    expect(first.subject).toBe(getQuestion(first.question_id).subject)
    expect(first.dailymed_url.endsWith(label.set_id)).toBe(true)
    expect(first.stance).toBe('warns_against')
    expect(label.sections[first.quote_section ?? '']).toContain(first.quote_text)
    // The whole candidate sentence, verbatim: not truncated or altered.
    const chosen = new Map(Object.entries(j.request.asked))
      .get(first.question_id)
      ?.find((c) => c.id === first.evidence)
    expect([first.quote_section, first.quote_text]).toEqual([chosen?.section, chosen?.text])
    expect(first.quote_lead_in).toBe(chosen?.lead_in?.text ?? null)
  })

  it('has no rows for skipped questions', async () => {
    const rows = labelRows('ibuprofen', await judged(await ibuprofenOtc()))

    expect(rows.map((r) => r.question_id)).not.toContain('boxed_warning')
  })

  it.each([
    ['caution', 0.99, 's1', 0.95, []],
    ['caution', 0.3, 's1', 0.3, []],
    ['no_known_issue', 0.99, 's1', 0.95, ['no_known_issue']],
    ['not_mentioned', 0.99, 's1', 0.95, ['stance_evidence_mismatch']],
    ['caution', 0.99, NONE, 0.95, ['stance_evidence_mismatch']],
    ['not_mentioned', 0.99, NONE, 0.95, []],
    ['no_known_issue', 0.5, NONE, 0.5, ['no_known_issue', 'stance_evidence_mismatch']],
  ])('flags %s %s %s %s as %j', (stance, sc, evidence, ec, expected) => {
    expect(flags(row(0, stance, sc, evidence, ec))).toEqual(expected)
  })

  it.each([
    [0.99, 0.95, 3],
    [0.95, 0.85, 2],
    [0.6, 0.99, 1],
    [0.99, 0.2, 0],
    [0.9, 0.7, 2],
  ])('bands %s and %s by the weaker confidence: %s', (sc, ec, expected) => {
    expect(confidenceBand(row(0, 'caution', sc, 's1', ec))).toBe(expected)
  })
})

describe('selecting rows', () => {
  it('keeps every flagged row and samples each band', () => {
    const flagged = Array.from({ length: 5 }, (_, n) => row(n, 'no_known_issue', 0.99))
    // 50 plain rows in each of the four bands.
    const confidences = [0.3, 0.6, 0.8, 0.99]
    const plain = Array.from({ length: 200 }, (_, n) => row(100 + n, 'caution', confidences[n % 4]))

    const selected = selectRows([...flagged, ...plain], 10, 7)

    const kept = selected.filter((r) => r.reasons.join() !== 'sample')
    expect(kept.map((r) => r.row_id)).toEqual(flagged.map((r) => r.row_id))
    expect(kept.every((r) => r.reasons.join() === 'no_known_issue')).toBe(true)
    const sampled = selected.filter((r) => r.reasons.join() === 'sample')
    const perBand = new Map<number, number>()
    for (const r of sampled)
      perBand.set(confidenceBand(r), (perBand.get(confidenceBand(r)) ?? 0) + 1)
    expect([...perBand.entries()].sort()).toEqual([
      [0, 10],
      [1, 10],
      [2, 10],
      [3, 10],
    ])
    expect(selectRows([...flagged, ...plain], 10, 7)).toEqual(selected)
    expect(selectRows([...flagged, ...plain], 10, 8)).not.toEqual(selected)
  })

  it('takes a band with fewer rows than asked whole', () => {
    const rows = Array.from({ length: 4 }, (_, n) => row(n, 'caution', 0.3))

    expect(selectRows(rows, 10, 1)).toHaveLength(4)
  })

  it('keeps label order', () => {
    const rows = Array.from({ length: 30 }, (_, n) =>
      row(n, n % 3 === 0 ? 'no_known_issue' : 'caution'),
    )
    const order = rows.map((r) => r.row_id)
    const selected = selectRows(rows, 5, 1).map((r) => r.row_id)

    expect(selected).toEqual([...selected].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
  })
})

describe('writing the sheet', () => {
  it('puts the row fields first, then blank review columns', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rx-jev-sheet-')), 'sheet.csv')
    writeCsv(path, [{ ...row(0, 'no_known_issue'), reasons: ['no_known_issue'] }])

    const [header, record] = readFileSync(path, 'utf8').trimEnd().split('\r\n')
    const columns = header?.split(',') ?? []
    const values = new Map(columns.map((c, i) => [c, record?.split(',')[i]]))
    expect(columns.slice(-REVIEW_COLUMNS.length)).toEqual([...REVIEW_COLUMNS])
    expect(REVIEW_COLUMNS.every((c) => values.get(c) === '')).toBe(true)
    expect(values.get('stance')).toBe('no_known_issue')
    expect(values.get('reasons')).toBe('no_known_issue')
    expect(values.get('sections')).toBe('warnings')
  })

  it('quotes fields that hold commas, quotes or line breaks', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rx-jev-sheet-')), 'sheet.csv')
    writeCsv(path, [{ ...row(0), quote_text: 'Use "caution", then\nstop.' }])

    expect(readFileSync(path, 'utf8')).toContain('"Use ""caution"", then\nstop."')
  })

  it('round-trips rows through JSON', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rx-jev-sheet-')), 'sheet.json')
    const rows = [row(0), row(1, 'caution', 0.99, NONE)]
    writeJson(path, rows)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(rows)
  })
})
