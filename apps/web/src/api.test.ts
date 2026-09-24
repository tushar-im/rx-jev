import { describe, expect, it } from 'vitest'
import { LabelAnswersSchema } from './api.ts'
import { labelAnswers } from './testing.ts'

describe('LabelAnswersSchema', () => {
  it('reads a judged time without a timezone as UTC', () => {
    const label = LabelAnswersSchema.parse(labelAnswers({ judged_at: '2026-09-21T00:30:00' }))

    expect(label.judged_at).toBe('2026-09-21T00:30:00Z')
  })

  it('keeps a judged time that already has a timezone', () => {
    const label = LabelAnswersSchema.parse(labelAnswers({ judged_at: '2026-09-21T00:30:00+00:00' }))

    expect(label.judged_at).toBe('2026-09-21T00:30:00+00:00')
  })
})
