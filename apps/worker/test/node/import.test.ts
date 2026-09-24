import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openD1, type OpenD1, WRANGLER_CONFIG } from '../../scripts/lib/d1.ts'
import { checkImport, importStore } from '../../scripts/lib/import.ts'
import { openSource } from '../../scripts/lib/source.ts'
import { LabelSchema } from '../../src/clients/openfda.ts'
import { judgeRuns, judgments, labels } from '../../src/db/schema.ts'
import { buildRequest, Judge } from '../../src/judge.ts'
import { FakeJev } from '../jev.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = resolve(HERE, '../../migrations')
const GOLDEN = resolve(HERE, '../../../../fixtures/golden/fixtures.json')

const dir = mkdtempSync(join(tmpdir(), 'rx-jev-import-'))
const sourcePath = join(dir, 'rx_jev.db')
const persistPath = join(dir, 'state')
const METFORMIN_SET_ID = '7cc02a26-5c22-445b-ad8f-3e7570c143d3'
let d1: OpenD1

/** A Python-shaped store holding one judged metformin label. */
async function writeSource(): Promise<void> {
  // The D1 migrations create the same tables the Python app had.
  const sqlite = new DatabaseSync(sourcePath)
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  sqlite.close()

  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { labels: { label: unknown }[] }
  const raw = golden.labels.find((g) => JSON.stringify(g.label).includes(METFORMIN_SET_ID))
  const label = LabelSchema.parse(raw?.label)
  const request = await buildRequest(label)
  const result = await new Judge(new FakeJev().client(), 'jev-latest').judge(request)

  const source = openSource(sourcePath, { readOnly: false })
  await source.db.insert(labels).values({
    set_id: label.set_id,
    version: label.version,
    raw: label,
    // Python wrote naive UTC timestamps.
    fetched_at: '2026-09-23 04:22:19.787423',
  })
  await source.db.insert(judgeRuns).values({
    id: 7,
    set_id: label.set_id,
    version: label.version,
    prompt_hash: request.promptHash,
    model: 'jev-latest',
    model_version: 'jev-1.13.0',
    latency_ms: 10,
    input_tokens: 1234,
    output_tokens: 56,
    created_at: '2026-09-23 04:22:19.791572',
  })
  await source.db.insert(judgments).values(
    Object.entries(result.distributions).map(([key, d]) => ({
      run_id: 7,
      question_id: key.slice(0, key.lastIndexOf('.')),
      kind: key.endsWith('.stance') ? ('stance' as const) : ('evidence' as const),
      choice: d.choice,
      confidence: d.confidence,
      probabilities: d.probabilities,
    })),
  )
  source.close()
}

beforeAll(async () => {
  await writeSource()
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      persistPath,
      '-c',
      WRANGLER_CONFIG,
    ],
    { stdio: 'ignore', env: { ...process.env, CI: '1' } },
  )
  // `--persist-to` keeps its state under v3, where the platform proxy looks.
  d1 = await openD1({ remote: false, persistPath: join(persistPath, 'v3') })
}, 120_000)

afterAll(async () => {
  await d1?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('importing the Python store into D1', () => {
  it('keeps every row and finds every run for its label', async () => {
    const source = openSource(sourcePath)
    const counts = await importStore(source.db, d1.db)
    const check = await checkImport(source.db, d1.db)
    source.close()

    expect(counts.labels).toBe(1)
    expect(counts.runs).toBe(1)
    expect(check.problems).toEqual([])
    expect(check.current).toBe(1)
    const [run] = await d1.db.select().from(judgeRuns)
    expect(run?.id).toBe(7)
    expect(run?.created_at).toBe('2026-09-23T04:22:19.791572Z')
  })

  it('can run again without duplicating anything', async () => {
    const source = openSource(sourcePath)
    await importStore(source.db, d1.db)
    await importStore(source.db, d1.db)
    const rows = await source.db.select().from(judgments)
    source.close()

    expect(await d1.db.select().from(judgeRuns)).toHaveLength(1)
    expect(await d1.db.select().from(judgments)).toHaveLength(rows.length)
  })
})
