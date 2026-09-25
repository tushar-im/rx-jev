import { writeFileSync } from 'node:fs'
import type { ProductType } from '@rx-jev/contract'
import type { JudgedLabel } from '../../src/answering.ts'
import { candidateSections, getQuestion } from '../../src/catalog.ts'
import { NONE } from '../../src/judge.ts'
import { labelAnswers } from '../../src/views.ts'

// Builds the Gate 1 review sheet from stored judgments (G1.2).
//
// One row per label and judged question, built from the same answers the API serves. Every
// flagged row is kept. The rest are sampled evenly across confidence bands, so accuracy can
// be measured at every confidence level without reading every answer. See
// docs/gate-1-review-rules.md for how rows are marked.

// Lower edges of confidence bands 1 to 3; band 0 is below the first. Used to choose rows to
// review, not to display answers: display thresholds come from the review itself.
export const BAND_EDGES = [0.5, 0.7, 0.9] as const

export type Reason = 'no_known_issue' | 'stance_evidence_mismatch' | 'sample'

// Filled in by the reviewer, in this order after the row's own fields.
export const REVIEW_COLUMNS = [
  'stance_ok',
  'correct_stance',
  'evidence_ok',
  'better_sentence',
  'unsure',
  'error_type',
  'notes',
] as const

export type ReviewRow = {
  row_id: string
  drug: string
  product_type: ProductType
  set_id: string
  version: string
  dailymed_url: string
  question_id: string
  title: string
  subject: string
  sections: string[]
  stance: string
  stance_confidence: number
  evidence: string
  evidence_confidence: number
  quote_section: string | null
  quote_lead_in: string | null
  quote_text: string | null
  // Why the row is in the sheet.
  reasons: Reason[]
}

export const ROW_FIELDS: (keyof ReviewRow)[] = [
  'row_id',
  'drug',
  'product_type',
  'set_id',
  'version',
  'dailymed_url',
  'question_id',
  'title',
  'subject',
  'sections',
  'stance',
  'stance_confidence',
  'evidence',
  'evidence_confidence',
  'quote_section',
  'quote_lead_in',
  'quote_text',
  'reasons',
]

/** One row per judged question of the label, in catalog order. */
export function labelRows(drug: string, judged: JudgedLabel): ReviewRow[] {
  // The threshold does not matter here: rows carry raw confidences, not verdicts.
  const served = labelAnswers(judged, 1)
  const rows: ReviewRow[] = []
  for (const answer of served.answers) {
    if (answer.status !== 'judged' || answer.stance === null || answer.evidence === null) continue
    const quote = answer.evidence.quote
    rows.push({
      row_id: `${served.set_id}:${answer.question_id}`,
      drug,
      product_type: served.product_type,
      set_id: served.set_id,
      version: served.version,
      dailymed_url: served.dailymed_url,
      question_id: answer.question_id,
      title: answer.title,
      subject: getQuestion(answer.question_id).subject,
      sections: candidateSections(answer.question_id, judged.label),
      stance: answer.stance.choice,
      stance_confidence: answer.stance.confidence,
      evidence: answer.evidence.choice,
      evidence_confidence: answer.evidence.confidence,
      quote_section: quote?.section ?? null,
      quote_lead_in: quote?.lead_in ?? null,
      quote_text: quote?.text ?? null,
      reasons: [],
    })
  }
  return rows
}

/** The band of the row's weaker confidence, 0 (lowest) to BAND_EDGES.length. */
export function confidenceBand(row: ReviewRow): number {
  const weaker = Math.min(row.stance_confidence, row.evidence_confidence)
  return BAND_EDGES.filter((edge) => weaker >= edge).length
}

/** Why a row must be reviewed, whatever the sample. */
export function flags(row: ReviewRow): Reason[] {
  const reasons: Reason[] = []
  if (row.stance === 'no_known_issue') reasons.push('no_known_issue')
  // `not_mentioned` should come with `none`, and any other stance with a sentence.
  if ((row.stance === 'not_mentioned') !== (row.evidence === NONE)) {
    reasons.push('stance_evidence_mismatch')
  }
  return reasons
}

/** A small seeded generator (mulberry32), so a sample can be drawn again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function sample<T>(items: T[], count: number, random: () => number): T[] {
  const pool = [...items]
  const picked: T[] = []
  while (picked.length < count && pool.length > 0) {
    const [item] = pool.splice(Math.floor(random() * pool.length), 1)
    if (item !== undefined) picked.push(item)
  }
  return picked
}

/** Every flagged row plus up to `perBand` others from each band, in the input order. */
export function selectRows(rows: ReviewRow[], perBand: number, seed: number): ReviewRow[] {
  const reasons = new Map(rows.map((r) => [r.row_id, flags(r)]))
  const bands = new Map<number, string[]>()
  for (const r of rows) {
    if ((reasons.get(r.row_id) ?? []).length > 0) continue
    const band = confidenceBand(r)
    bands.set(band, [...(bands.get(band) ?? []), r.row_id])
  }
  const random = seeded(seed)
  for (const band of [...bands.keys()].sort()) {
    for (const rowId of sample(bands.get(band) ?? [], perBand, random)) {
      reasons.set(rowId, ['sample'])
    }
  }
  return rows
    .filter((r) => (reasons.get(r.row_id) ?? []).length > 0)
    .map((r) => ({ ...r, reasons: reasons.get(r.row_id) ?? [] }))
}

/** One CSV field, quoted when it holds a comma, a quote or a line break. */
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvField).join(',')}\r\n`
}

/** A row's own fields as CSV values, with lists joined by commas. */
export function rowValues(row: ReviewRow): unknown[] {
  return ROW_FIELDS.map((field) => {
    const value = row[field]
    return Array.isArray(value) ? value.join(', ') : value
  })
}

export function writeCsv(path: string, rows: ReviewRow[]): void {
  const lines = [csvLine([...ROW_FIELDS, ...REVIEW_COLUMNS])]
  for (const row of rows) lines.push(csvLine([...rowValues(row), ...REVIEW_COLUMNS.map(() => '')]))
  writeFileSync(path, lines.join(''))
}

export function writeJson(path: string, rows: ReviewRow[]): void {
  writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`)
}
