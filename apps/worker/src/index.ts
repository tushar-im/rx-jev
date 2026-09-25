import { createApp } from './app.ts'
import { refreshDrugNames } from './cache.ts'
import { readConfig } from './config.ts'
import type { Env } from './env.ts'
import { rxnormClient, workerServices } from './services.ts'

export { AskLimiter } from './limiter.ts'

const app = createApp(workerServices)

// Default export required by the Workers runtime.
export default {
  fetch: app.fetch,
  // The daily Cron Trigger refreshes RxNorm's name list for suggestions.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshDrugNames(rxnormClient(readConfig({ ...env })), env.CACHE))
  },
} satisfies ExportedHandler<Env>
