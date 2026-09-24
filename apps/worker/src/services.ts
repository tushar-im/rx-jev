import type { Services } from './app.ts'
import { readConfig } from './config.ts'
import type { Env } from './env.ts'

// The production services, from the Worker's bindings.
export function workerServices(env: Env): Services {
  return { config: readConfig({ ...env }) }
}
