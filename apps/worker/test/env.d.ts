import type { D1Migration } from 'cloudflare:test'
import type { Env as WorkerEnv } from '../src/env.ts'

// Types `env` from cloudflare:test as the Worker's own bindings.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
