import { eq } from 'drizzle-orm'
import { LabelSchema } from '../../src/clients/openfda.ts'
import type { Db } from '../../src/db/index.ts'
import { judgeRuns, judgments, labels } from '../../src/db/schema.ts'
import { buildRequest } from '../../src/judge.ts'
import { Store } from '../../src/store.ts'
import { isoUtc, type SourceDb } from './source.ts'

// Moves the Python store into D1, keeping every ID, and checks the result. Rows already in
// D1 are left as they are, so an interrupted import can simply be run again.

// D1 binds at most 100 parameters per statement.
const RUNS_PER_INSERT = 9
const JUDGMENTS_PER_INSERT = 12
const STATEMENTS_PER_BATCH = 40

export type ImportCounts = { labels: number; runs: number; judgments: number }

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function runBatches(db: Db, statements: Parameters<Db['batch']>[0][number][]): Promise<void> {
  for (const group of chunks(statements, STATEMENTS_PER_BATCH)) {
    const [first, ...rest] = group
    if (first) await db.batch([first, ...rest])
  }
}

export async function importStore(
  source: SourceDb,
  target: Db,
  log: (line: string) => void = () => {},
): Promise<ImportCounts> {
  const labelRows = await source.select().from(labels)
  const runRows = await source.select().from(judgeRuns)
  const judgmentRows = await source.select().from(judgments)

  // Labels one per statement: a label can be hundreds of kilobytes.
  await runBatches(
    target,
    labelRows.map((row) =>
      target
        .insert(labels)
        .values({ ...row, fetched_at: isoUtc(row.fetched_at) })
        .onConflictDoNothing(),
    ),
  )
  log(`${labelRows.length} labels`)
  await runBatches(
    target,
    chunks(runRows, RUNS_PER_INSERT).map((rows) =>
      target
        .insert(judgeRuns)
        .values(rows.map((row) => ({ ...row, created_at: isoUtc(row.created_at) })))
        .onConflictDoNothing(),
    ),
  )
  log(`${runRows.length} runs`)
  await runBatches(
    target,
    chunks(judgmentRows, JUDGMENTS_PER_INSERT).map((rows) =>
      target.insert(judgments).values(rows).onConflictDoNothing(),
    ),
  )
  log(`${judgmentRows.length} judgments`)
  return { labels: labelRows.length, runs: runRows.length, judgments: judgmentRows.length }
}

export type ImportCheck = {
  // Source runs that D1 does not serve for their label, or serves differently.
  problems: string[]
  runs: number
  // Labels whose current prompt hash has a stored run, so they load without calling Jev.
  current: number
  labels: number
}

/** Confirms that every source run is found for its label in D1, with the same judgments. */
export async function checkImport(
  source: SourceDb,
  target: Db,
  model?: string,
): Promise<ImportCheck> {
  const store = new Store(target)
  const problems: string[] = []
  const runRows = await source.select().from(judgeRuns)
  for (const run of runRows) {
    const label = await store.label(run.set_id, run.version)
    if (label === null) {
      problems.push(`run ${run.id}: label ${run.set_id} v${run.version} is missing`)
      continue
    }
    const found = await store.find(label, run.prompt_hash, run.model)
    const expected = await source.select().from(judgments).where(eq(judgments.run_id, run.id))
    if (found === null) problems.push(`run ${run.id}: not found for its label`)
    else if (found.id !== run.id) problems.push(`run ${run.id}: found run ${found.id} instead`)
    else if (Object.keys(found.judgments).length !== expected.length) {
      problems.push(
        `run ${run.id}: ${Object.keys(found.judgments).length} of ${expected.length} judgments`,
      )
    }
  }

  const labelRows = await source.select().from(labels)
  let current = 0
  for (const row of labelRows) {
    const label = LabelSchema.parse(row.raw)
    const request = await buildRequest(label)
    const models = model ? [model] : [...new Set(runRows.map((r) => r.model))]
    for (const m of models) {
      if (await store.find(label, request.promptHash, m)) {
        current += 1
        break
      }
    }
  }
  return { problems, runs: runRows.length, current, labels: labelRows.length }
}
