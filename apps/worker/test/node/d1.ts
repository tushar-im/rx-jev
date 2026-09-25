import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openD1, WRANGLER_CONFIG } from '../../scripts/lib/d1.ts'
import type { Db } from '../../src/db/index.ts'
import { judgeRuns, judgments, labels, openfdaCache } from '../../src/db/schema.ts'

/** A local D1 in a temporary folder with the current migrations, for Node tool tests. */
export async function tempD1(): Promise<{
  db: Db
  clear: () => Promise<void>
  dispose: () => Promise<void>
}> {
  const dir = mkdtempSync(join(tmpdir(), 'rx-jev-d1-'))
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
      dir,
      '-c',
      WRANGLER_CONFIG,
    ],
    { stdio: 'ignore', env: { ...process.env, CI: '1' } },
  )
  // `--persist-to` keeps its state under v3, where the platform proxy looks.
  const d1 = await openD1({ remote: false, persistPath: join(dir, 'v3') })
  return {
    db: d1.db,
    clear: async () => {
      await d1.db.delete(judgments)
      await d1.db.delete(judgeRuns)
      await d1.db.delete(labels)
      await d1.db.delete(openfdaCache)
    },
    dispose: async () => {
      await d1.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
