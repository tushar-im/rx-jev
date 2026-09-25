import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import { checkLabel, type LabelGolden } from '../golden.ts'

// The golden file of the whole local store, written by the retired Python app before M6.11.
// It is not committed (it holds every stored label), so this runs only where it exists.
const HERE = dirname(fileURLToPath(import.meta.url))
const STORE = resolve(HERE, '../../../../fixtures/golden/store.jsonl')
const CUSTOM_QUESTION = 'Can I drink grapefruit juice while taking this?'

const entries: LabelGolden[] = existsSync(STORE)
  ? readFileSync(STORE, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LabelGolden)
  : []

describe.skipIf(entries.length === 0)('golden files of every stored label', () => {
  it.each(entries.map((g) => [`${g.label.set_id} v${String(g.label.version)}`, g] as const))(
    'builds the same requests for %s',
    async (_name, entry) => {
      await checkLabel(entry, CUSTOM_QUESTION, { bodies: false })
    },
  )
})
