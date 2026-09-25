// Import the Python judgment store into D1 (M6.6), then check every run is found.
//
//   node scripts/import-store.ts [path/to/rx_jev.db] [--remote]
//
// Without --remote it fills the local D1 that `wrangler dev` uses; apply the migrations
// first with `npx wrangler d1 migrations apply DB --local`. With --remote it writes to the
// deployed database (after `wrangler login` and `wrangler d1 migrations apply DB --remote`).

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openD1, parseTarget } from './lib/d1.ts'
import { checkImport, importStore } from './lib/import.ts'
import { openSource } from './lib/source.ts'

const DEFAULT_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../../api/rx_jev.db')

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const path = args.find((a) => !a.startsWith('--')) ?? DEFAULT_SOURCE
  if (!existsSync(path)) throw new Error(`No store at ${path}`)
  const target = parseTarget(args)
  const source = openSource(path)
  const d1 = await openD1(target)
  try {
    console.log(`Importing ${path} into the ${target.remote ? 'remote' : 'local'} D1`)
    await importStore(source.db, d1.db, (line) => console.log(`  ${line}`))
    const check = await checkImport(source.db, d1.db)
    console.log(`${check.runs - check.problems.length}/${check.runs} runs found for their label.`)
    console.log(
      `${check.current}/${check.labels} labels have a run for today's prompt, so load without Jev.`,
    )
    if (check.problems.length > 0) {
      console.error(check.problems.join('\n'))
      process.exitCode = 1
    }
  } finally {
    source.close()
    await d1.dispose()
  }
}

await main()
