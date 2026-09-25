import { suggest } from '@rx-jev/contract/suggest'
import { describe, expect, it } from 'vitest'

const NAMES = [
  'advair',
  'advil',
  'advil pm',
  'glipiZIDE / metFORMIN',
  'metFORMIN',
  'sitagliptin / metFORMIN',
  'tylenol',
  'tylenol pm',
]

describe('suggest', () => {
  it('matches prefixes ignoring case', () => {
    expect(suggest(NAMES, 'ADV')).toEqual(['advil', 'advair', 'advil pm'])
  })

  it('puts shorter names first among prefix matches', () => {
    expect(suggest(NAMES, 'tylenol')).toEqual(['tylenol', 'tylenol pm'])
  })

  it('follows prefix matches with word-start matches', () => {
    expect(suggest(NAMES, 'metf')).toEqual([
      'metFORMIN',
      'glipiZIDE / metFORMIN',
      'sitagliptin / metFORMIN',
    ])
  })

  it('ignores matches inside a word', () => {
    expect(suggest(NAMES, 'formin')).toEqual([])
  })

  it('ignores surrounding space', () => {
    expect(suggest(NAMES, '  advil ')).toEqual(['advil', 'advil pm'])
  })

  it('caps the list at the limit', () => {
    expect(suggest(NAMES, 'a', 2)).toEqual(['advil', 'advair'])
  })

  it('treats regex characters in the query literally', () => {
    expect(suggest(['a.b', 'axb'], 'a.b')).toEqual(['a.b'])
  })
})
