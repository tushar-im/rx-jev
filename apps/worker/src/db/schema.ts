import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// The judgment store, as the Python app kept it: one row per label version, one run per
// label version, prompt hash and requested model, and one judgment per question and kind.
// Distributions are stored whole; verdicts are derived at read time.

export const labels = sqliteTable(
  'label',
  {
    set_id: text('set_id').notNull(),
    version: text('version').notNull(),
    // The label as openFDA gave it, sections included, for review and re-reads.
    raw: text('raw', { mode: 'json' }).notNull().$type<unknown>(),
    // ISO 8601 in UTC.
    fetched_at: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.set_id, t.version] })],
)

export const judgeRuns = sqliteTable(
  'judge_run',
  {
    // Chosen by the writer, so a run and its judgments are written in one batch.
    id: integer('id').primaryKey(),
    set_id: text('set_id').notNull(),
    version: text('version').notNull(),
    prompt_hash: text('prompt_hash').notNull(),
    // As requested, the lookup key.
    model: text('model').notNull(),
    // As reported by Jev.
    model_version: text('model_version').notNull(),
    latency_ms: integer('latency_ms').notNull(),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    // ISO 8601 in UTC.
    created_at: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('judge_run_key').on(t.set_id, t.version, t.prompt_hash, t.model),
    index('judge_run_set_id').on(t.set_id),
  ],
)

export const judgments = sqliteTable(
  'judgment',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    run_id: integer('run_id')
      .notNull()
      .references(() => judgeRuns.id),
    question_id: text('question_id').notNull(),
    kind: text('kind', { enum: ['stance', 'evidence'] }).notNull(),
    choice: text('choice').notNull(),
    confidence: real('confidence').notNull(),
    probabilities: text('probabilities', { mode: 'json' })
      .notNull()
      .$type<Record<string, number>>(),
    reviewed: integer('reviewed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('judgment_run_id').on(t.run_id)],
)

// openFDA canonical label lookups by ingredient set, reused for 24 hours.
export const openfdaCache = sqliteTable('openfda_cache', {
  // The ingredient names as JSON, in RxNorm's order.
  key: text('key').primaryKey(),
  // The canonical labels and match counts of the lookup.
  body: text('body', { mode: 'json' }).notNull().$type<unknown>(),
  fetched_at_ms: integer('fetched_at_ms').notNull(),
})

export const schema = { labels, judgeRuns, judgments, openfdaCache }
