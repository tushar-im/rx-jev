import type { Hono } from 'hono'
import { type AppEnv, createApp, type Services } from '../src/app.ts'
import { readConfig } from '../src/config.ts'

export function testServices(overrides: Partial<Services> = {}): Services {
  return { config: readConfig({}), ...overrides }
}

export function testApp(overrides: Partial<Services> = {}): Hono<AppEnv> {
  return createApp(() => testServices(overrides))
}
