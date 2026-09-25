// The web Worker: serves the Vite build and hands /api/* to the API Worker through a
// service binding, so the app keeps its relative /api calls on one origin and needs no
// CORS. The API Worker has no public URL of its own.

export type WebEnv = {
  // The API Worker (rx-jev-api).
  API: Fetcher
  // The static build in dist/.
  ASSETS: Fetcher
}

export function route(request: Request, env: WebEnv): Promise<Response> {
  const { pathname } = new URL(request.url)
  const api = pathname === '/api' || pathname.startsWith('/api/')
  // The request is passed on whole, so CF-Connecting-IP still names the client.
  return api ? env.API.fetch(request) : env.ASSETS.fetch(request)
}

// Default export required by the Workers runtime.
export default {
  fetch: (request, env) => route(request, env),
} satisfies ExportedHandler<WebEnv>
