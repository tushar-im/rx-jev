// Sliding-window rate limits per client.
//
// Every custom question calls Jev live, so asks are limited per client. On Workers the
// limiter lives in a Durable Object per client (see limiter.ts), which saves its hits so
// they survive the object being evicted.

export type Limit = { count: number; seconds: number }

/** One counted hit, held by the request that made it so it can give back exactly it. */
export type Slot = { key: string; id: number; at: number }

export type Clock = () => number

/** A limiter's state: hits inside some window, and the next slot ID to hand out. */
export type Saved = { hits: Slot[]; nextId: number }

const secondsNow: Clock = () => Date.now() / 1000

function recent(hits: Slot[], now: number, seconds: number): number {
  return hits.filter((h) => h.at > now - seconds).length
}

export class RateLimiter {
  readonly #limits: Limit[]
  readonly #clock: Clock
  readonly #span: number
  readonly #hits = new Map<string, Slot[]>()
  #nextId = 0

  constructor(limits: Limit[], clock: Clock = secondsNow, saved?: Saved) {
    this.#limits = limits
    this.#clock = clock
    this.#span = Math.max(0, ...limits.map((l) => l.seconds))
    // IDs keep counting across saves, so a late release never matches a newer slot.
    this.#nextId = saved?.nextId ?? 0
    for (const slot of saved?.hits ?? []) {
      this.#hits.set(slot.key, [...(this.#hits.get(slot.key) ?? []), slot])
    }
  }

  /**
   * Counts a hit for `key` and returns its slot, or, if a limit is spent, returns the
   * seconds until it frees up and counts nothing.
   */
  acquire(key: string): Slot | number {
    const now = this.#clock()
    this.#forget(now)
    const hits = this.#hits.get(key) ?? []
    const wait = this.#wait(hits, now)
    if (wait !== null) return wait
    const slot = { key, id: this.#nextId++, at: now }
    this.#hits.set(key, [...hits, slot])
    return slot
  }

  /** Like `acquire`, for a caller that never gives its slot back. */
  hit(key: string): number | null {
    const result = this.acquire(key)
    return typeof result === 'number' ? result : null
  }

  /**
   * Takes back exactly this slot, for a request that turned out not to count. Other
   * requests' slots are untouched; a slot already released or expired is ignored.
   */
  release(slot: Slot): void {
    const hits = this.#hits.get(slot.key)
    if (hits === undefined) return
    const remaining = hits.filter((h) => h.id !== slot.id)
    if (remaining.length > 0) this.#hits.set(slot.key, remaining)
    else this.#hits.delete(slot.key)
  }

  /** Clients with a hit still inside some window. */
  clients(): number {
    this.#forget(this.#clock())
    return this.#hits.size
  }

  /** Every hit still inside some window, to save and restore later. */
  snapshot(): Saved {
    this.#forget(this.#clock())
    return { hits: [...this.#hits.values()].flat(), nextId: this.#nextId }
  }

  #wait(hits: Slot[], now: number): number | null {
    const waits = this.#limits
      .filter((limit) => recent(hits, now, limit.seconds) >= limit.count)
      .map((limit) => (hits[hits.length - limit.count]?.at ?? now) + limit.seconds - now)
    return waits.length > 0 ? Math.max(...waits) : null
  }

  #forget(now: number): void {
    for (const [key, hits] of this.#hits) {
      const kept = hits.filter((h) => h.at > now - this.#span)
      if (kept.length > 0) this.#hits.set(key, kept)
      else this.#hits.delete(key)
    }
  }
}

/** What the ask route needs from a limiter, wherever its counts live. */
export interface ClientLimiter {
  acquire(client: string): Promise<Slot | number>
  release(slot: Slot): Promise<void>
}
