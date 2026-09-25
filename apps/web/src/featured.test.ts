import { describe, expect, it } from 'vitest'
import { DRUG_POOL, SPHERE_SIZE, sampleDrugs } from './featured.ts'

// A fixed sequence of "random" numbers, repeated.
function sequence(...values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

describe('DRUG_POOL', () => {
  it('holds more drugs than one sphere shows, so visits differ', () => {
    expect(DRUG_POOL.length).toBeGreaterThanOrEqual(2 * SPHERE_SIZE)
  })

  it('has no repeats', () => {
    expect(new Set(DRUG_POOL.map((n) => n.toLowerCase())).size).toBe(DRUG_POOL.length)
  })

  it('keeps to one-word names, which stay readable on the sphere', () => {
    expect(DRUG_POOL.filter((n) => !/^[a-z]+$/i.test(n))).toEqual([])
  })
})

describe('sampleDrugs', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f']

  it('picks the requested number of distinct names from the pool', () => {
    const picked = sampleDrugs(pool, 4, sequence(0.9, 0.1, 0.5, 0.3))

    expect(picked).toHaveLength(4)
    expect(new Set(picked).size).toBe(4)
    for (const name of picked) expect(pool).toContain(name)
  })

  it('picks differently for different random numbers', () => {
    expect(sampleDrugs(pool, 3, sequence(0))).not.toEqual(sampleDrugs(pool, 3, sequence(0.99)))
  })

  it('returns the whole pool, shuffled, when asked for more than it holds', () => {
    expect([...sampleDrugs(pool, 10, sequence(0.4))].sort()).toEqual(pool)
  })

  it('leaves the pool as it was', () => {
    const copy = [...pool]
    sampleDrugs(pool, 3, sequence(0.7))

    expect(pool).toEqual(copy)
  })
})
