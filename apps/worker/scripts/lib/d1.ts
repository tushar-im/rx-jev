import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPlatformProxy, unstable_readConfig } from 'wrangler'
import { createDb, type Db } from '../../src/db/index.ts'

// D1 for the Node tools, through Wrangler's platform proxy: the local database `wrangler dev`
// uses, or with `remote` the deployed one (after `wrangler login`). Either way the tools use
// the same Drizzle D1 driver as the Worker.

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const WRANGLER_CONFIG = resolve(WORKER_DIR, 'wrangler.jsonc')
export const LOCAL_STATE = resolve(WORKER_DIR, '.wrangler/state/v3')

export type D1Target = { remote: boolean; persistPath?: string }

export type OpenD1 = { db: Db; dispose: () => Promise<void> }

export async function openD1(target: D1Target): Promise<OpenD1> {
  const config = unstable_readConfig({ config: WRANGLER_CONFIG })
  const d1 = config.d1_databases.find((d: { binding: string }) => d.binding === 'DB')
  if (d1 === undefined) throw new Error('wrangler.jsonc has no D1 binding named DB')
  if (target.remote && !d1.database_id) {
    throw new Error('Set database_id for DB in wrangler.jsonc (wrangler d1 create rx-jev).')
  }
  // Only the D1 binding: the tools need no Durable Object or KV.
  const toolsDir = resolve(WORKER_DIR, '.wrangler/tools')
  mkdirSync(toolsDir, { recursive: true })
  const toolsConfig = resolve(toolsDir, 'wrangler.json')
  writeFileSync(
    toolsConfig,
    JSON.stringify({
      name: 'rx-jev-tools',
      compatibility_date: config.compatibility_date,
      d1_databases: [
        {
          binding: 'DB',
          database_name: d1.database_name,
          database_id: d1.database_id,
          remote: target.remote,
        },
      ],
    }),
  )
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: toolsConfig,
    persist: { path: target.persistPath ?? LOCAL_STATE },
    remoteBindings: target.remote,
    envFiles: [],
  })
  return { db: createDb(proxy.env.DB), dispose: () => proxy.dispose() }
}

export function parseTarget(args: string[]): D1Target {
  return { remote: args.includes('--remote') }
}
