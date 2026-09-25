import { DatabaseSync } from 'node:sqlite'
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { schema } from '../../src/db/schema.ts'

// The Python app's SQLite store, read through Drizzle. Its tables and columns have the same
// names as the D1 schema; only timestamps differ (naive "YYYY-MM-DD HH:MM:SS" in UTC).

export type SourceDb = SqliteRemoteDatabase<typeof schema>

export function openSource(
  path: string,
  { readOnly = true }: { readOnly?: boolean } = {},
): { db: SourceDb; close: () => void } {
  const sqlite = new DatabaseSync(path, { readOnly })
  const db = drizzle(
    async (query, params, method) => {
      const statement = sqlite.prepare(query)
      const values = params as never[]
      if (method === 'run') {
        statement.run(...values)
        return { rows: [] }
      }
      // Single-table selects, so each row's values are in column order.
      const rows = statement.all(...values).map((row) => Object.values(row))
      return { rows: method === 'get' ? (rows[0] ?? []) : rows }
    },
    { schema },
  )
  return { db, close: () => sqlite.close() }
}

/** A Python timestamp as ISO 8601 in UTC: "2026-09-23 04:22:19.79" -> "2026-09-23T04:22:19.79Z". */
export function isoUtc(timestamp: string): string {
  if (/(Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return timestamp.replace(' ', 'T')
  return `${timestamp.replace(' ', 'T')}Z`
}
