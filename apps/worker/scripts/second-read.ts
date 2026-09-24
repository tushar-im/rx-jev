// Blind second read of the Gate 1 review sheet (G1.3).
//
//   npm run tools:second-read -- packets [--remote]   # writes second_read/packets/*.json
//   npm run tools:second-read -- compare              # reads second_read/grades/*.json
//
// Packets hold each row's question and candidate sentences, never Jev's answer, batched by
// label so shared text is read once. Each grade batch is a JSON list of
// {"row_id", "stance", "evidence", "note"}. `compare` writes review_sheet_compared.csv with
// both readings and lists the rows the owner must decide.

import { readFileSync, writeFileSync } from 'node:fs'
import { Store } from '../src/store.ts'
import { openD1, parseTarget } from './lib/d1.ts'
import { csvLine, REVIEW_COLUMNS, ROW_FIELDS, type ReviewRow, rowValues } from './lib/review.ts'
import {
  compare,
  loadCandidateIds,
  type Packet,
  packet,
  readGrades,
  writePacketBatches,
} from './lib/second-read.ts'

const SHEET = 'review_sheet.json'
const ROOT = 'second_read'
// Characters of sentence text per packet batch, so one reader can hold a batch at once.
const BATCH_CHARS = 120_000

async function writePackets(rows: ReviewRow[], args: string[]): Promise<void> {
  const items: Packet[] = []
  const d1 = await openD1(parseTarget(args))
  try {
    const store = new Store(d1.db)
    const ordered = [...rows].sort((a, b) =>
      a.set_id === b.set_id ? a.row_id.localeCompare(b.row_id) : a.set_id.localeCompare(b.set_id),
    )
    for (const row of ordered) {
      const label = await store.label(row.set_id, row.version)
      if (label === null)
        throw new Error(`Label ${row.set_id} v${row.version} is not in the store.`)
      items.push(packet(row, label))
    }
  } finally {
    await d1.dispose()
  }
  const count = writePacketBatches(`${ROOT}/packets`, items, BATCH_CHARS)
  console.log(`${items.length} rows in ${count} packet batches under ${ROOT}/packets/`)
}

function writeComparison(rows: ReviewRow[]): void {
  const candidateIds = loadCandidateIds(
    `${ROOT}/packets`,
    rows.map((r) => r.row_id),
  )
  const results = compare(rows, readGrades(`${ROOT}/grades`), candidateIds)
  const path = 'review_sheet_compared.csv'
  const header = [
    ...ROW_FIELDS,
    'claude_stance',
    'claude_evidence',
    'claude_note',
    'stance_agrees',
    'evidence_match',
    'needs_human',
    ...REVIEW_COLUMNS,
  ]
  const lines = [csvLine(header)]
  for (const r of results) {
    lines.push(
      csvLine([
        ...rowValues(r.row),
        r.grade?.stance ?? '',
        r.grade?.evidence ?? '',
        r.grade?.note ?? '',
        r.stance_agrees ? 'True' : 'False',
        r.evidence ?? '',
        r.needs_human ? 'True' : 'False',
        ...REVIEW_COLUMNS.map(() => ''),
      ]),
    )
  }
  writeFileSync(path, lines.join(''))

  const graded = results.filter((r) => r.graded)
  const evidence = new Map<string, number>()
  for (const r of graded) evidence.set(r.evidence ?? '', (evidence.get(r.evidence ?? '') ?? 0) + 1)
  console.log(`${graded.length}/${results.length} rows graded.`)
  console.log(`Stance agrees: ${graded.filter((r) => r.stance_agrees).length}/${graded.length}`)
  console.log('Evidence:', Object.fromEntries(evidence))
  console.log(`Rows needing a human: ${results.filter((r) => r.needs_human).length}. Wrote ${path}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const rows = JSON.parse(readFileSync(SHEET, 'utf8')) as ReviewRow[]
  if (args[0] === 'packets') await writePackets(rows, args)
  else if (args[0] === 'compare') writeComparison(rows)
  else throw new Error('Usage: second-read.ts packets | compare')
}

await main()
