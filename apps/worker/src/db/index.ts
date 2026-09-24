import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import { schema } from './schema.ts'

export type Db = DrizzleD1Database<typeof schema>

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema })
}
