// Precompute stored judgments for the Gate 1 review set.
//
//   npm run tools:precompute -- [names.txt] [report.json] [--remote]
//
// Judgments go to the local D1, or with --remote the deployed one. Re-running only calls
// Jev for labels the store lacks. The report lists every drug's status, labels, tokens,
// latency and skipped questions.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import {
  type DrugReport,
  precomputeOne,
  readNames,
  unvalidatedLabels,
  writeReport,
} from './lib/batch.ts'
import { toolClients, toolConfig } from './lib/clients.ts'
import { openD1, parseTarget } from './lib/d1.ts'

const NAMES = resolve(dirname(fileURLToPath(import.meta.url)), 'review_set.txt')
const REPORT = 'review_set_report.json'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const [namesPath = NAMES, reportPath = REPORT] = args.filter((a) => !a.startsWith('--'))
  const config = toolConfig()
  const { rxnorm, openfda, judge } = toolClients(config)
  if (config.openfdaApiKey === null) {
    console.log('OPENFDA_API_KEY is not set; anonymous openFDA access may hit its daily limit.')
  }

  const names = readNames(readFileSync(namesPath, 'utf8'))
  const d1 = await openD1(parseTarget(args))
  const reports: DrugReport[] = []
  try {
    const store = new Store(d1.db)
    for (const name of names) {
      const report = await precomputeOne(name, rxnorm, openfda, judge, store)
      reports.push(report)
      // Rewrite after every drug so an interrupted run still leaves a complete report.
      writeReport(reportPath, reports)
      const tokens = report.labels
        .filter((l) => l.fresh)
        .reduce((n, l) => n + (l.input_tokens ?? 0), 0)
      const error = report.error ? `  error=${report.error}` : ''
      console.log(
        `${report.status.padEnd(16)} ${name}  labels=${report.labels.length}  new_tokens=${tokens}${error}`,
      )
    }
  } finally {
    await d1.dispose()
  }

  const failed = reports.filter((r) => r.status !== 'ok').map((r) => r.name)
  console.log(`\n${reports.length - failed.length}/${reports.length} ok. Report: ${reportPath}`)
  if (failed.length > 0) console.log(`Not ok: ${failed.join(', ')}`)
  const unvalidated = unvalidatedLabels(reports, config.validatedModelVersion)
  if (unvalidated.length > 0) {
    console.log(
      `Judged by a Jev version other than ${config.validatedModelVersion}, so re-check the ` +
        `Gate 1 thresholds: ${unvalidated.join(', ')}`,
    )
  }
}

await main()
