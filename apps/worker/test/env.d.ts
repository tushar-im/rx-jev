import type { Env } from '../src/env.ts'

declare global {
  namespace Cloudflare {
    interface Env extends import('../src/env.ts').Env {}
  }
}

export type { Env }
