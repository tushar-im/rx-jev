import { Hono } from 'hono'
import type { OpenFdaClient } from './clients/openfda.ts'
import type { RxNormClient } from './clients/rxnorm.ts'
import type { Config } from './config.ts'
import type { Env } from './env.ts'
import { registerProblemHandlers } from './problems.ts'
import { drugRoutes } from './routes/drugs.ts'
import { healthRoutes } from './routes/health.ts'
import { labelRoutes } from './routes/labels.ts'

// What the routes use, built once per request from the Worker's bindings. Tests build it
// from recorded upstreams and a fake Jev instead.
export type Services = {
  config: Config
  rxnorm: RxNormClient
  openfda: OpenFdaClient
  // RxNorm's display names, for suggestions.
  drugNames: () => Promise<readonly string[]>
}

export type ServicesFactory = (env: Env) => Services

export type AppEnv = { Bindings: Env; Variables: { services: Services } }

export function createApp(makeServices: ServicesFactory): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerProblemHandlers(app)
  app.use('/api/*', async (c, next) => {
    c.set('services', makeServices(c.env))
    await next()
  })
  app.route('/api/health', healthRoutes)
  app.route('/api/drugs', drugRoutes)
  app.route('/api/labels', labelRoutes)
  return app
}
