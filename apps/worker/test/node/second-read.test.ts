import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { labelRows, type ReviewRow } from '../../scripts/lib/review.ts'
import {
  compare,
  type Grade,
  loadCandidateIds,
  packet,
  readGrades,
  writePacketBatches,
} from '../../scripts/lib/second-read.ts'
import { judgeLabels } from '../../src/answering.ts'
import type { Label } from '../../src/clients/openfda.ts'
import { Judge, NONE } from '../../src/judge.ts'
import { Store } from '../../src/store.ts'
import { FakeJev } from '../jev.ts'
import { metforminRx } from '../labels.ts'
import { tempD1 } from './d1.ts'

let d1: Awaited<ReturnType<typeof tempD1>>
let label: Label
let rows: ReviewRow[]
let ids: Map<string, Set<string>>

beforeAll(async () => {
  d1 = await tempD1()
}, 120_000)
afterAll(async () => d1?.dispose())

beforeEach(async () => {
  await d1.clear()
  label = await metforminRx()
  const [judged] = await judgeLabels(
    [label],
    new Judge(new FakeJev().client(), 'jev-latest'),
    new Store(d1.db),
  )
  if (!judged) throw new Error('Not judged')
  rows = labelRows('metformin', judged)
  // Each row's candidate sentence IDs, as its packet offers them.
  ids = new Map(rows.map((r) => [r.row_id, new Set(packet(r, label).candidates.map((c) => c.id))]))
})

function first(): ReviewRow {
  const r = rows[0]
  if (!r) throw new Error('No rows')
  return r
}

function grade(r: ReviewRow, stance?: string, evidence?: string): Grade {
  return {
    row_id: r.row_id,
    stance: (stance ?? r.stance) as Grade['stance'],
    evidence: evidence ?? r.evidence,
    note: '',
  }
}

function otherStance(r: ReviewRow): string {
  return r.stance !== 'caution' ? 'caution' : 'dose_change'
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rx-jev-second-read-'))
}

function item(rowId: string, ...candidateIds: string[]) {
  return { row_id: rowId, candidates: candidateIds.map((id) => ({ id, text: 'x'.repeat(10) })) }
}

describe('packets', () => {
  it("hold the sentences but not Jev's answer", () => {
    const r = first()
    const p = packet(r, label)

    expect(p.row_id).toBe(r.row_id)
    expect(p.subject).toBe(r.subject)
    expect(p.sections).toEqual(r.sections)
    expect(p.candidates.every((c) => r.sections.includes(c.section))).toBe(true)
    expect(p.candidates.some((c) => c.id === r.evidence)).toBe(true)
    const text = JSON.stringify(p)
    for (const hidden of ['stance', 'confidence', 'evidence', 'reasons']) {
      expect(text).not.toContain(`"${hidden}`)
    }
  })

  it('replace batches from an earlier sheet', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '007.json'), JSON.stringify([item('stale', 's9')]))
    const count = writePacketBatches(dir, [item('a', 's1'), item('b', 's2')], 10)

    expect(count).toBe(2)
    expect(readdirSync(dir).sort()).toEqual(['001.json', '002.json'])
  })

  it('load the candidate IDs of exactly the current rows', () => {
    const dir = tempDir()
    writePacketBatches(dir, [item('a', 's1', 's2'), item('b', 's3')], 100)

    expect(loadCandidateIds(dir, ['a', 'b'])).toEqual(
      new Map([
        ['a', new Set(['s1', 's2'])],
        ['b', new Set(['s3'])],
      ]),
    )
  })

  it('reject a row in two packets', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '001.json'), JSON.stringify([item('a', 's1')]))
    writeFileSync(join(dir, '002.json'), JSON.stringify([item('a', 's2')]))

    expect(() => loadCandidateIds(dir, ['a'])).toThrow(/a/)
  })

  it('reject packets for rows not in the sheet', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '001.json'), JSON.stringify([item('a', 's1'), item('old', 's2')]))

    expect(() => loadCandidateIds(dir, ['a'])).toThrow(/old/)
  })

  it('reject sheet rows without a packet', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '001.json'), JSON.stringify([item('a', 's1')]))

    expect(() => loadCandidateIds(dir, ['a', 'b'])).toThrow(/b/)
  })
})

describe('comparing the readings', () => {
  it('agrees on stance and sentence', () => {
    const [result] = compare(rows.slice(0, 1), [grade(first())], ids)

    expect([result?.stance_agrees, result?.evidence]).toEqual([true, 'same'])
    expect(result?.needs_human).toBe(false)
  })

  it('needs a human for a different stance', () => {
    const [result] = compare(rows.slice(0, 1), [grade(first(), otherStance(first()))], ids)

    expect(result?.stance_agrees).toBe(false)
    expect(result?.needs_human).toBe(true)
  })

  it('does not escalate a different supporting sentence', () => {
    const other = [...(ids.get(first().row_id) ?? [])]
      .filter((id) => id !== first().evidence)
      .sort()[0]
    const [result] = compare(rows.slice(0, 1), [grade(first(), undefined, other)], ids)

    expect(result?.evidence).toBe('other_sentence')
    expect(result?.needs_human).toBe(false)
  })

  it('needs a human for a sentence against none', () => {
    const [result] = compare(rows.slice(0, 1), [grade(first(), undefined, NONE)], ids)

    expect(result?.evidence).toBe('none_mismatch')
    expect(result?.needs_human).toBe(true)
  })

  it('reports rows without a grade as ungraded', () => {
    const results = compare(rows.slice(0, 2), [grade(first())], ids)

    expect(results.map((r) => r.graded)).toEqual([true, false])
    expect(results[1]?.needs_human).toBe(true)
  })

  it('rejects two grades for one row', () => {
    const duplicate = [grade(first()), grade(first(), otherStance(first()))]

    expect(() => compare(rows.slice(0, 1), duplicate, ids)).toThrow(first().row_id)
  })

  it('rejects evidence that is not a candidate of the row', () => {
    expect(() => compare(rows.slice(0, 1), [grade(first(), undefined, 'made-up-id')], ids)).toThrow(
      'made-up-id',
    )
  })

  it('merges grade files and rejects bad stances', () => {
    const dir = tempDir()
    const good = { row_id: 'a', stance: 'caution', evidence: 's1', note: '' }
    writeFileSync(join(dir, '001.json'), JSON.stringify([good]))
    writeFileSync(join(dir, '002.json'), JSON.stringify([{ ...good, row_id: 'b' }]))
    expect(readGrades(dir).map((g) => g.row_id)).toEqual(['a', 'b'])

    writeFileSync(join(dir, '003.json'), JSON.stringify([{ ...good, stance: 'safe' }]))
    expect(() => readGrades(dir)).toThrow()
  })
})
