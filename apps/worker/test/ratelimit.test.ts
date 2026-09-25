import { beforeEach, describe, expect, it } from 'vitest'
import { RateLimiter, type Slot } from '../src/ratelimit.ts'

let now = 1_000
const clock = (): number => now

beforeEach(() => {
  now = 1_000
})

function isSlot(value: Slot | number): value is Slot {
  return typeof value !== 'number'
}

describe('RateLimiter', () => {
  it('allows up to the limit, then says how long to wait', () => {
    const limiter = new RateLimiter([{ count: 2, seconds: 60 }], clock)
    expect(limiter.hit('a')).toBeNull()
    now += 10
    expect(limiter.hit('a')).toBeNull()
    now += 5
    // The oldest hit leaves the window 60 s after it was made, 45 s from now.
    expect(limiter.hit('a')).toBeCloseTo(45)
  })

  it('slides the window', () => {
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }], clock)
    expect(limiter.hit('a')).toBeNull()
    now += 60
    expect(limiter.hit('a')).toBeNull()
  })

  it('does not count rejected hits', () => {
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }], clock)
    limiter.hit('a')
    for (let i = 0; i < 5; i++) {
      now += 10
      expect(limiter.hit('a')).not.toBeNull()
    }
    now += 10
    expect(limiter.hit('a')).toBeNull()
  })

  it('returns a slot, or how long to wait', () => {
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }], clock)
    expect(isSlot(limiter.acquire('a'))).toBe(true)
    now += 15
    expect(limiter.acquire('a')).toBeCloseTo(45)
  })

  it('takes back only the released slot', () => {
    const limiter = new RateLimiter([{ count: 2, seconds: 60 }], clock)
    const first = limiter.acquire('a')
    now += 10
    expect(isSlot(limiter.acquire('a'))).toBe(true)
    if (!isSlot(first)) throw new Error('Expected a slot')
    // The earlier request gives its slot back while the later one still holds its own.
    limiter.release(first)
    expect(limiter.hit('a')).toBeNull()
    // Only the later hits remain, so the window frees 60 s after them, not 50 s.
    expect(limiter.hit('a')).toBeCloseTo(60)
  })

  it('ignores a slot released twice or after expiry', () => {
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }], clock)
    const slot = limiter.acquire('a')
    if (!isSlot(slot)) throw new Error('Expected a slot')
    limiter.release(slot)
    limiter.release(slot)
    expect(limiter.clients()).toBe(0)
    expect(limiter.hit('a')).toBeNull()
    now += 61
    limiter.release(slot)
    expect(limiter.hit('a')).toBeNull()
  })

  it('counts clients apart', () => {
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }], clock)
    expect(limiter.hit('a')).toBeNull()
    expect(limiter.hit('b')).toBeNull()
    expect(limiter.hit('a')).not.toBeNull()
  })

  it('applies every limit', () => {
    const limiter = new RateLimiter(
      [
        { count: 2, seconds: 60 },
        { count: 3, seconds: 3_600 },
      ],
      clock,
    )
    for (let i = 0; i < 3; i++) {
      expect(limiter.hit('a')).toBeNull()
      now += 60
    }
    // Under the minute limit, but the hourly one is spent until the first hit is an hour old.
    expect(limiter.hit('a')).toBeCloseTo(3_600 - 180)
  })

  it('forgets clients with no hits in any window', () => {
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }], clock)
    limiter.hit('a')
    now += 61
    limiter.hit('b')
    expect(limiter.clients()).toBe(1)
  })

  it('restores the hits it saved', () => {
    const limiter = new RateLimiter([{ count: 1, seconds: 60 }], clock)
    limiter.hit('a')

    const restored = new RateLimiter([{ count: 1, seconds: 60 }], clock, limiter.snapshot())
    now += 30
    expect(restored.hit('a')).toBeCloseTo(30)
  })
})
