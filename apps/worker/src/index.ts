import { createApp } from './app.ts'
import type { Env } from './env.ts'
import { workerServices } from './services.ts'

export { AskLimiter } from './limiter.ts'

const app = createApp(workerServices)

// Default export required by the Workers runtime.
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
