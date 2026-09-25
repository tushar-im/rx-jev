import { describe, it } from 'vitest'
import { type GoldenFile, checkLabel, checkShortlist } from './golden.ts'
// Written from the recorded fixtures by the retired Python app (scripts/write_golden.py,
// removed in M6.11 and kept in the Git history).
import golden from '../../../fixtures/golden/fixtures.json'

const file = golden as unknown as GoldenFile

describe('golden files from Python', () => {
  it.each(file.labels.map((g) => [g.label.set_id, g] as const))(
    'builds the same requests for %s',
    async (_setId, entry) => {
      await checkLabel(entry, file.custom_question, { bodies: true })
    },
  )

  it('builds the same shortlist request', async () => {
    await checkShortlist(file)
  })
})
