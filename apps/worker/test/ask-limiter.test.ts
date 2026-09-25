import { env, evictDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { durableAskLimiter } from '../src/limiter.ts'
import type { Slot } from '../src/ratelimit.ts'

const ONE_A_MINUTE = [{ count: 1, seconds: 60 }]

function isSlot(value: Slot | number): value is Slot {
  return typeof value !== 'number'
}

describe('the ask limiter Durable Object', () => {
  it('limits each client on its own', async () => {
    const limiter = durableAskLimiter(env.ASK_LIMITER, ONE_A_MINUTE)

    expect(isSlot(await limiter.acquire('198.51.100.1'))).toBe(true)
    expect(isSlot(await limiter.acquire('198.51.100.2'))).toBe(true)
    const wait = await limiter.acquire('198.51.100.1')
    expect(isSlot(wait)).toBe(false)
    expect(wait).toBeGreaterThan(59)
    expect(wait).toBeLessThanOrEqual(60)
  })

  it('takes back a released slot', async () => {
    const limiter = durableAskLimiter(env.ASK_LIMITER, ONE_A_MINUTE)
    const slot = await limiter.acquire('198.51.100.1')
    if (!isSlot(slot)) throw new Error('Expected a slot')

    await limiter.release(slot)
    expect(isSlot(await limiter.acquire('198.51.100.1'))).toBe(true)
  })

  it('keeps its counts when the object is evicted', async () => {
    const limiter = durableAskLimiter(env.ASK_LIMITER, ONE_A_MINUTE)
    await limiter.acquire('198.51.100.1')

    await evictDurableObject(env.ASK_LIMITER.get(env.ASK_LIMITER.idFromName('198.51.100.1')))
    expect(isSlot(await limiter.acquire('198.51.100.1'))).toBe(false)
  })
})
