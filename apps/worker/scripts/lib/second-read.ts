import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StanceSchema } from '@rx-jev/contract'
import { z } from 'zod'
import type { Label } from '../../src/clients/openfda.ts'
import { NONE } from '../../src/judge.ts'
import { labelCandidates } from '../../src/sentences.ts'
import type { ReviewRow } from './review.ts'

// A blind second read of the Gate 1 review sheet (G1.3).
//
// A second reader grades each row from packets that hold the row's candidate sentences but
// not Jev's answer. Comparing the two readings leaves the owner only the rows where they
// disagree on what the label says. A different sentence supporting the same stance is not
// escalated: the review rules accept any sentence that supports the correct stance.

// `same` sentence, an `other_sentence` (both real), or one side chose `none`.
export type EvidenceMatch = 'same' | 'other_sentence' | 'none_mismatch'

export const GradeSchema = z.object({
  row_id: z.string(),
  stance: StanceSchema,
  // A candidate ID, or `none`.
  evidence: z.string(),
  note: z.string().default(''),
})
export type Grade = z.infer<typeof GradeSchema>

export type Comparison = {
  row: ReviewRow
  grade: Grade | null
  graded: boolean
  stance_agrees: boolean
  evidence: EvidenceMatch | null
  // True when the owner must decide: the readings disagree, or the row is ungraded.
  needs_human: boolean
}

export type PacketCandidate = { id: string; section: string; lead_in: string | null; text: string }

export type Packet = {
  row_id: string
  drug: string
  product_type: string
  subject: string
  sections: string[]
  candidates: PacketCandidate[]
}

/** What the second reader sees for a row: the question and its sentences, no answer. */
export function packet(row: ReviewRow, label: Label): Packet {
  return {
    row_id: row.row_id,
    drug: row.drug,
    product_type: row.product_type,
    subject: row.subject,
    sections: row.sections,
    candidates: labelCandidates(label, row.sections).map((c) => ({
      id: c.id,
      section: c.section,
      lead_in: c.lead_in?.text ?? null,
      text: c.text,
    })),
  }
}

type BatchItem = { row_id: string; candidates: { id: string; text: string }[] }

function jsonFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

/**
 * Replaces the folder's packet batches, so no batch from an earlier sheet survives. A batch
 * closes once adding the next row would pass `batchChars` of sentence text. Returns the
 * number of batches written.
 */
export function writePacketBatches(directory: string, items: BatchItem[], batchChars: number): number {
  mkdirSync(directory, { recursive: true })
  for (const old of jsonFiles(directory)) rmSync(join(directory, old))

  const batches: BatchItem[][] = [[]]
  let size = 0
  for (const item of items) {
    const chars = item.candidates.reduce((n, c) => n + [...c.text].length, 0)
    const current = batches.at(-1) ?? []
    if (current.length > 0 && size + chars > batchChars) {
      batches.push([])
      size = 0
    }
    batches.at(-1)?.push(item)
    size += chars
  }
  batches.forEach((batch, n) => {
    writeFileSync(join(directory, `${String(n + 1).padStart(3, '0')}.json`), JSON.stringify(batch, null, 1))
  })
  return batches.length
}

const PacketFile = z.array(
  z.object({ row_id: z.string(), candidates: z.array(z.object({ id: z.string() })) }),
)

/**
 * Each current row's candidate IDs from the packets, which must match the sheet exactly.
 * Throws for a row in two packets, a packet row not in the sheet (a stale batch), or a
 * sheet row without a packet.
 */
export function loadCandidateIds(directory: string, rowIds: string[]): Map<string, Set<string>> {
  const wanted = new Set(rowIds)
  const ids = new Map<string, Set<string>>()
  for (const name of jsonFiles(directory)) {
    for (const item of PacketFile.parse(JSON.parse(readFileSync(join(directory, name), 'utf8')))) {
      if (ids.has(item.row_id)) {
        throw new Error(`Row ${item.row_id} appears in more than one packet (${name}).`)
      }
      if (!wanted.has(item.row_id)) {
        throw new Error(`Packet ${name} holds row ${item.row_id}, not in the sheet.`)
      }
      ids.set(item.row_id, new Set(item.candidates.map((c) => c.id)))
    }
  }
  const missing = rowIds.filter((r) => !ids.has(r))
  if (missing.length > 0) throw new Error(`No packet for rows: ${missing.join(', ')}.`)
  return ids
}

/** Every grade in the folder's JSON batch files, in file order. */
export function readGrades(directory: string): Grade[] {
  return jsonFiles(directory).flatMap((name) => {
    const parsed = z.array(GradeSchema).safeParse(JSON.parse(readFileSync(join(directory, name), 'utf8')))
    if (!parsed.success) throw new Error(`Bad grade in ${name}: ${parsed.error.message}`)
    return parsed.data
  })
}

function evidenceMatch(jev: string, other: string): EvidenceMatch {
  if (jev === other) return 'same'
  if (jev === NONE || other === NONE) return 'none_mismatch'
  return 'other_sentence'
}

/**
 * Both readings of every row. `candidateIds` holds each row's packet sentence IDs. Throws
 * for a row graded twice, or evidence that is not one of the row's candidates: either would
 * let a malformed grade pass as agreement.
 */
export function compare(
  rows: ReviewRow[],
  grades: Grade[],
  candidateIds: Map<string, Set<string>>,
): Comparison[] {
  const byRow = new Map<string, Grade>()
  for (const g of grades) {
    if (byRow.has(g.row_id)) throw new Error(`Row ${g.row_id} is graded more than once.`)
    if (g.evidence !== NONE && !candidateIds.get(g.row_id)?.has(g.evidence)) {
      throw new Error(`Row ${g.row_id} grades evidence ${g.evidence}, not a candidate.`)
    }
    byRow.set(g.row_id, g)
  }
  return rows.map((row) => {
    const grade = byRow.get(row.row_id)
    if (grade === undefined) {
      return { row, grade: null, graded: false, stance_agrees: false, evidence: null, needs_human: true }
    }
    const stanceAgrees = grade.stance === row.stance
    const evidence = evidenceMatch(row.evidence, grade.evidence)
    return {
      row,
      grade,
      graded: true,
      stance_agrees: stanceAgrees,
      evidence,
      needs_human: !stanceAgrees || evidence === 'none_mismatch',
    }
  })
}
