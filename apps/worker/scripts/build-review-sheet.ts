// Build the Gate 1 review sheet from the review-set report and the stored judgments (G1.2).
//
//   npm run tools:review-sheet -- [report.json] [per_band] [seed] [--remote]
//
// Writes review_sheet.csv and review_sheet.json. Never calls Jev: labels without a stored
// run are listed and left out. Mark rows as described in docs/gate-1-review-rules.md.

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { buildRequest } from '../src/judge.ts'
import { Store } from '../src/store.ts'
import { toolConfig } from './lib/clients.ts'
import { openD1, parseTarget } from './lib/d1.ts'
import { labelRows, type ReviewRow, selectRows, writeCsv, writeJson } from './lib/review.ts'

const Report = z.array(
  z.object({
    name: z.string(),
    labels: z.array(
      z.object({
        set_id: z.string(),
        version: z.string(),
        product_type: z.string(),
        model_version: z.string().nullable(),
      }),
    ),
  }),
)

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const [reportPath = 'review_set_report.json', perBand = '60', seed = '1'] = args.filter(
    (a) => !a.startsWith('--'),
  )
  const config = toolConfig()
  const report = Report.parse(JSON.parse(readFileSync(reportPath, 'utf8')))

  const rows: ReviewRow[] = []
  const missing: string[] = []
  const d1 = await openD1(parseTarget(args))
  try {
    const store = new Store(d1.db)
    for (const drug of report) {
      for (const entry of drug.labels) {
        const where = `${drug.name} (${entry.product_type})`
        const label = await store.label(entry.set_id, entry.version)
        if (label === null) {
          if (entry.model_version !== null) missing.push(where)
          continue
        }
        const request = await buildRequest(label)
        const run = await store.find(label, request.promptHash, config.typesafeModel)
        if (run === null) {
          missing.push(where)
          continue
        }
        rows.push(...labelRows(drug.name, { label, request, run, fresh: false }))
      }
    }
  } finally {
    await d1.dispose()
  }

  const selected = selectRows(rows, Number(perBand), Number(seed))
  writeCsv('review_sheet.csv', selected)
  writeJson('review_sheet.json', selected)

  const reasons = new Map<string, number>()
  for (const reason of selected.flatMap((r) => r.reasons)) {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  console.log(`${rows.length} judged answers, ${selected.length} selected for review.`)
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(26)} ${count}`)
  }
  if (missing.length > 0) console.log(`No stored run, left out: ${missing.join(', ')}`)
  console.log('Wrote review_sheet.csv and review_sheet.json')
}

await main()
