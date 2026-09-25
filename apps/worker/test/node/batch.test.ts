import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type DrugReport,
  type LabelReport,
  precompute,
  readNames,
  unvalidatedLabels,
  writeReport,
} from '../../scripts/lib/batch.ts'
import { OpenFdaClient } from '../../src/clients/openfda.ts'
import { readConfig } from '../../src/config.ts'
import type { Db } from '../../src/db/index.ts'
import { Judge } from '../../src/judge.ts'
import { Store } from '../../src/store.ts'
import { OPENFDA_BASE, recordedOpenFda, recordedRxNorm } from '../helpers.ts'
import { FakeJev, MODEL_VERSION } from '../jev.ts'
import { mockFetch } from '../recorded.ts'
import { tempD1 } from './d1.ts'

const MODEL = 'jev-latest'
let d1: Awaited<ReturnType<typeof tempD1>>
let db: Db

beforeAll(async () => {
  d1 = await tempD1()
  db = d1.db
}, 120_000)
afterAll(async () => d1?.dispose())
beforeEach(async () => d1.clear())

function run(names: string[], jev: FakeJev, openfda: OpenFdaClient = recordedOpenFda()) {
  return precompute(names, recordedRxNorm(), openfda, new Judge(jev.client(), MODEL), new Store(db))
}

function labelReport(overrides: Partial<LabelReport> = {}): LabelReport {
  return {
    set_id: 's',
    version: '1',
    product_type: 'otc',
    fresh: false,
    model_version: null,
    latency_ms: null,
    input_tokens: null,
    output_tokens: null,
    skipped: {},
    ...overrides,
  }
}

describe('precompute', () => {
  it('judges every canonical label of every drug', async () => {
    const jev = new FakeJev()
    const reports = await run(['Advil', 'metformin'], jev)

    expect(reports.map((r) => [r.name, r.status, r.rxcui])).toEqual([
      ['Advil', 'ok', '5640'],
      ['metformin', 'ok', '6809'],
    ])
    expect(reports[0]?.labels.map((l) => l.product_type)).toEqual(['otc', 'prescription'])
    expect(jev.requests).toHaveLength(3)
    const otc = reports[0]?.labels[0]
    expect(otc?.fresh).toBe(true)
    expect(otc?.model_version).toBe(MODEL_VERSION)
    expect([otc?.input_tokens, otc?.output_tokens]).toEqual([1234, 56])
    expect(otc?.skipped).toEqual({ boxed_warning: 'no_sections' })
  })

  it('reuses stored judgments on a rerun', async () => {
    const jev = new FakeJev()
    await run(['metformin'], jev)
    const again = await run(['metformin'], jev)

    expect(jev.requests).toHaveLength(1)
    expect(again[0]?.status).toBe('ok')
    expect(again[0]?.labels[0]?.fresh).toBe(false)
  })

  it('reports a Jev failure and carries on', async () => {
    class FailsFirst extends FakeJev {
      override async handle(init: RequestInit | undefined): Promise<Response> {
        this.status = this.requests.length === 0 ? 529 : 200
        return super.handle(init)
      }
    }
    const reports = await run(['metformin', 'Tylenol PM'], new FailsFirst())

    expect(reports.map((r) => r.status)).toEqual(['jev_failed', 'ok'])
    expect(reports[0]?.labels).toEqual([])
    expect(reports[0]?.error).toBeTruthy()
  })

  it('reports an unknown drug without raising', async () => {
    const jev = new FakeJev()
    const [report] = await run(['xyzzynotadrug'], jev)

    expect(report?.status).toBe('not_found')
    expect(jev.requests).toEqual([])
  })

  it('reports an upstream failure', async () => {
    const down = new OpenFdaClient({
      baseUrl: OPENFDA_BASE,
      fetch: mockFetch(() => new Response(null, { status: 503 })),
    })
    const [report] = await run(['metformin'], new FakeJev(), down)

    expect(report?.status).toBe('upstream_failed')
  })

  it('lists labels judged by another model version', async () => {
    const reports = await run(['Advil', 'metformin'], new FakeJev())

    expect(unvalidatedLabels(reports, MODEL_VERSION)).toEqual([])
    expect(unvalidatedLabels(reports, 'jev-1.12.0')).toEqual([
      `Advil (otc, ${MODEL_VERSION})`,
      `Advil (prescription, ${MODEL_VERSION})`,
      `metformin (prescription, ${MODEL_VERSION})`,
    ])
  })
})

describe('reports', () => {
  it('writes complete JSON and leaves no temporary files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rx-jev-report-'))
    const path = join(dir, 'report.json')
    const reports: DrugReport[] = [
      { name: 'metformin', status: 'not_found', rxcui: null, labels: [], error: null },
    ]
    writeReport(path, reports)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(reports)
    expect(readdirSync(dir)).toEqual(['report.json'])
  })

  it('keeps the previous report when a write is interrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rx-jev-report-'))
    const path = join(dir, 'report.json')
    const first: DrugReport = { name: 'first', status: 'ok', rxcui: null, labels: [], error: null }
    writeReport(path, [first])
    const before = readFileSync(path, 'utf8')

    const interrupted = () => {
      throw new Error('interrupted')
    }
    expect(() => writeReport(path, [first, first], interrupted)).toThrow('interrupted')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['report.json'])
  })

  it('does not list labels without a run as unvalidated', () => {
    const report: DrugReport = {
      name: 'x',
      status: 'ok',
      rxcui: null,
      labels: [labelReport()],
      error: null,
    }

    expect(unvalidatedLabels([report], MODEL_VERSION)).toEqual([])
  })

  it('validates against the Gate 1 model by default', () => {
    expect(readConfig({}).validatedModelVersion).toBe('jev-1.13.0')
  })

  it('reads names, skipping blanks, comments and repeats', () => {
    expect(readNames('# review set\nibuprofen\n\n  metformin  \nIbuprofen\n')).toEqual([
      'ibuprofen',
      'metformin',
    ])
  })
})
