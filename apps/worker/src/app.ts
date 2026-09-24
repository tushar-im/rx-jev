import { Hono } from 'hono'
import type { Config } from './config.ts'
import type { Env } from './env.ts'
import { registerProblemHandlers } from './problems.ts'
import { healthRoutes } from './routes/health.ts'

// What the routes use, built once per request from the Worker's bindings. Tests build it
// from recorded upstreams and a fake Jev instead.
export type Services = {
  config: Config
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
  return app
}
