import { and, eq } from 'drizzle-orm'
import { type Label, LabelSchema } from './clients/openfda.ts'
import type { Db } from './db/index.ts'
import { judgeRuns, judgments, labels } from './db/schema.ts'
import {
  type Distribution,
  type JudgeRequest,
  type JudgeResult,
  type Kind,
  questionKey,
} from './judge.ts'

// Stores Jev's full distributions per label version, so each label is judged once.
//
// A run is keyed by label `set_id` and `version`, the request's prompt hash, and the
// requested model. Any change to the label text, the questions, or the requested model
// misses the store and triggers a fresh run. Verdicts are not stored: they are derived at
// read time, so thresholds can change without re-running inference.
//
// D1 has no interactive transactions, so a run is written as one batch: the label row (kept
// if already there), the run and its judgments, all or nothing. The writer picks the run's
// ID so its judgments can reference it inside that batch.

export type StoredJudgment = { distribution: Distribution; reviewed: boolean }

export type StoredRun = {
  id: number
  prompt_hash: string
  model: string
  model_version: string
  latency_ms: number
  input_tokens: number | null
  output_tokens: number | null
  // ISO 8601 in UTC.
  created_at: string
  // Keyed by questionKey(questionId, kind).
  judgments: Record<string, StoredJudgment>
}

// D1 binds at most 100 parameters per statement; a judgment row binds 7.
const JUDGMENTS_PER_INSERT = 12

/** A random positive ID well inside the safe integer range. */
function newRunId(): number {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2))
  return (high & 0x1fffff) * 0x100000000 + low + 1
}

export class Store {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async find(label: Label, promptHash: string, model: string): Promise<StoredRun | null> {
    const [run] = await this.#db
      .select()
      .from(judgeRuns)
      .where(
        and(
          eq(judgeRuns.set_id, label.set_id),
          eq(judgeRuns.version, label.version),
          eq(judgeRuns.prompt_hash, promptHash),
          eq(judgeRuns.model, model),
        ),
      )
      .limit(1)
    return run ? this.#load(run) : null
  }

  async save(
    label: Label,
    request: JudgeRequest,
    model: string,
    result: JudgeResult,
  ): Promise<StoredRun> {
    const existing = await this.find(label, request.promptHash, model)
    if (existing) return existing

    const now = new Date().toISOString()
    const run = {
      id: newRunId(),
      set_id: label.set_id,
      version: label.version,
      prompt_hash: request.promptHash,
      model,
      model_version: result.model_version,
      latency_ms: result.latency_ms,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      created_at: now,
    }
    const rows = Object.entries(result.distributions).map(([key, d]) => {
      const { questionId, kind } = splitKey(key)
      return {
        run_id: run.id,
        question_id: questionId,
        kind,
        choice: d.choice,
        confidence: d.confidence,
        probabilities: d.probabilities,
        reviewed: false,
      }
    })

    const db = this.#db
    const inserts = []
    for (let i = 0; i < rows.length; i += JUDGMENTS_PER_INSERT) {
      inserts.push(db.insert(judgments).values(rows.slice(i, i + JUDGMENTS_PER_INSERT)))
    }
    try {
      await db.batch([
        // Writers judging one label version under different prompts share this row.
        db
          .insert(labels)
          .values({ set_id: label.set_id, version: label.version, raw: label, fetched_at: now })
          .onConflictDoNothing(),
        db.insert(judgeRuns).values(run),
        ...inserts,
      ])
    } catch (error) {
      // The run key is taken: another writer stored the same run first. Serve that one.
      const stored = await this.find(label, request.promptHash, model)
      if (stored === null) throw error
      return stored
    }
    return {
      ...run,
      judgments: Object.fromEntries(
        Object.entries(result.distributions).map(([key, distribution]) => [
          key,
          { distribution, reviewed: false },
        ]),
      ),
    }
  }

  async label(setId: string, version: string): Promise<Label | null> {
    const [row] = await this.#db
      .select({ raw: labels.raw })
      .from(labels)
      .where(and(eq(labels.set_id, setId), eq(labels.version, version)))
      .limit(1)
    return row ? LabelSchema.parse(row.raw) : null
  }

  async #load(run: typeof judgeRuns.$inferSelect): Promise<StoredRun> {
    const rows = await this.#db.select().from(judgments).where(eq(judgments.run_id, run.id))
    return {
      ...run,
      judgments: Object.fromEntries(
        rows.map((row) => [
          questionKey(row.question_id, row.kind),
          {
            distribution: {
              choice: row.choice,
              confidence: row.confidence,
              probabilities: row.probabilities,
            },
            reviewed: row.reviewed,
          },
        ]),
      ),
    }
  }
}

function splitKey(key: string): { questionId: string; kind: Kind } {
  const at = key.lastIndexOf('.')
  const kind = key.slice(at + 1)
  if (kind !== 'stance' && kind !== 'evidence') throw new Error(`Not a judgment kind: ${kind}`)
  return { questionId: key.slice(0, at), kind }
}
