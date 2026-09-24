import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Label } from '../src/clients/openfda.ts'
import { createDb, type Db } from '../src/db/index.ts'
import { judgments, labels } from '../src/db/schema.ts'
import { buildRequest, Judge, type JudgeRequest, type JudgeResult } from '../src/judge.ts'
import { Store } from '../src/store.ts'
import { FakeJev, MODEL_VERSION } from './jev.ts'
import { metforminRx } from './labels.ts'

const MODEL = 'jev-latest'

let db: Db
let label: Label
let request: JudgeRequest
let result: JudgeResult

beforeEach(async () => {
  db = createDb(env.DB)
  label = await metforminRx()
  request = await buildRequest(label)
  result = await new Judge(new FakeJev().client(), MODEL).judge(request)
})

describe('Store', () => {
  it('misses on an empty store', async () => {
    expect(await new Store(db).find(label, request.promptHash, MODEL)).toBeNull()
  })

  it('round-trips judgments with their full distributions', async () => {
    await new Store(db).save(label, request, MODEL, result)

    const stored = await new Store(db).find(label, request.promptHash, MODEL)
    expect(stored?.model_version).toBe(MODEL_VERSION)
    expect(new Set(Object.keys(stored?.judgments ?? {}))).toEqual(
      new Set(Object.keys(result.distributions)),
    )
    for (const [key, distribution] of Object.entries(result.distributions)) {
      expect(stored?.judgments[key]?.distribution).toEqual(distribution)
      expect(stored?.judgments[key]?.reviewed).toBe(false)
    }
  })

  it('keeps one row per question and kind', async () => {
    await new Store(db).save(label, request, MODEL, result)
    const rows = await db.select().from(judgments)

    expect(rows).toHaveLength(Object.keys(result.distributions).length)
    expect(new Set(rows.filter((r) => r.question_id === 'pregnancy').map((r) => r.kind))).toEqual(
      new Set(['stance', 'evidence']),
    )
  })

  it('records the latency, tokens and hash of the run', async () => {
    const stored = await new Store(db).save(label, request, MODEL, result)

    expect(stored.prompt_hash).toBe(request.promptHash)
    expect(stored.model).toBe(MODEL)
    expect([stored.input_tokens, stored.output_tokens]).toEqual([1234, 56])
    expect(stored.latency_ms).toBe(result.latency_ms)
    expect(stored.created_at).toMatch(/Z$/)
  })

  it.each([
    { prompt_hash: 'other' },
    { model: 'jev-1.0.0' },
    { version: '999' },
    { set_id: 'other-set' },
  ])('misses when any key part differs: %j', async (change) => {
    await new Store(db).save(label, request, MODEL, result)
    const other = {
      ...label,
      version: change.version ?? label.version,
      set_id: change.set_id ?? label.set_id,
    }

    const found = await new Store(db).find(
      other,
      change.prompt_hash ?? request.promptHash,
      change.model ?? MODEL,
    )
    expect(found).toBeNull()
  })

  it('keeps the first run when the same key is saved twice', async () => {
    const first = await new Store(db).save(label, request, MODEL, result)
    const later: JudgeResult = {
      ...result,
      model_version: 'jev-9.9.9',
      latency_ms: result.latency_ms + 999,
      distributions: Object.fromEntries(
        Object.entries(result.distributions).map(([k, d]) => [k, { ...d, confidence: 0.01 }]),
      ),
    }
    const second = await new Store(db).save(label, request, MODEL, later)

    expect(second).toEqual(first)
    expect(await new Store(db).find(label, request.promptHash, MODEL)).toEqual(first)
    expect(first.model_version).toBe(MODEL_VERSION)
    expect(await db.select().from(judgments)).toHaveLength(Object.keys(result.distributions).length)
  })

  it('serves the run a rival stored first between its check and its write', async () => {
    const rival = new Store(db)
    const rivalResult = { ...result, model_version: 'jev-rival' }

    class Racing extends Store {
      checked = false

      override async find(...args: Parameters<Store['find']>): ReturnType<Store['find']> {
        if (!this.checked) {
          this.checked = true
          await rival.save(label, request, MODEL, rivalResult)
          return null
        }
        return super.find(...args)
      }
    }

    const stored = await new Racing(db).save(label, request, MODEL, result)

    expect(stored.model_version).toBe('jev-rival')
    expect(await db.select().from(judgments)).toHaveLength(Object.keys(result.distributions).length)
  })

  it('does not lose a distinct run when a rival stored the label row', async () => {
    // Another deployment judged the same label version under a different prompt hash.
    await db.insert(labels).values({
      set_id: label.set_id,
      version: label.version,
      raw: label,
      fetched_at: new Date().toISOString(),
    })

    const stored = await new Store(db).save(label, request, MODEL, result)

    expect(stored.prompt_hash).toBe(request.promptHash)
    expect(await new Store(db).find(label, request.promptHash, MODEL)).toEqual(stored)
  })

  it('serves runs under different keys from one label row', async () => {
    const first = await new Store(db).save(label, request, MODEL, result)
    const second = await new Store(db).save(
      label,
      { ...request, promptHash: 'other-prompt' },
      MODEL,
      result,
    )

    expect(second.id).not.toBe(first.id)
    expect(await db.select().from(labels)).toHaveLength(1)
  })

  it('keeps the label JSON for review', async () => {
    await new Store(db).save(label, request, MODEL, result)

    expect(await new Store(db).label(label.set_id, label.version)).toEqual(label)
  })
})
