import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.ts'
import { type ClientLimiter, type Limit, RateLimiter, type Saved, type Slot } from './ratelimit.ts'

// The ask rate limit on Workers: one Durable Object per client address, so every request
// from that client, on any Worker instance, counts against the same windows. A Durable
// Object handles one call at a time, and its hits are saved after each call, so they
// survive the object being evicted.

const STATE = 'limiter'

export class AskLimiter extends DurableObject<Env> {
  async acquire(key: string, limits: Limit[]): Promise<Slot | number> {
    const limiter = await this.#load(limits)
    const result = limiter.acquire(key)
    await this.ctx.storage.put(STATE, limiter.snapshot())
    return result
  }

  async release(slot: Slot, limits: Limit[]): Promise<void> {
    const limiter = await this.#load(limits)
    limiter.release(slot)
    await this.ctx.storage.put(STATE, limiter.snapshot())
  }

  async #load(limits: Limit[]): Promise<RateLimiter> {
    const saved = await this.ctx.storage.get<Saved>(STATE)
    return new RateLimiter(limits, undefined, saved)
  }
}

/** A limiter whose counts live in one AskLimiter object per client. */
export function durableAskLimiter(
  namespace: DurableObjectNamespace<AskLimiter>,
  limits: Limit[],
): ClientLimiter {
  const stub = (client: string) => namespace.get(namespace.idFromName(client))
  return {
    acquire: (client) => stub(client).acquire(client, limits),
    release: (slot) => stub(slot.key).release(slot, limits),
  }
}
