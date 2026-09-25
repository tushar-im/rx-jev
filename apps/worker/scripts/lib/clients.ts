import { TypeSafeClient } from '@typesafe-ai/sdk'
import { OpenFdaClient } from '../../src/clients/openfda.ts'
import { RxNormClient } from '../../src/clients/rxnorm.ts'
import { type Config, readConfig } from '../../src/config.ts'
import type { Fetch } from '../../src/http.ts'
import { Judge } from '../../src/judge.ts'

// Upstream clients for the Node tools, configured like the Worker from the environment.
// Run the tools with `node --env-file-if-exists=.dev.vars`, the file `wrangler dev` reads.

const globalFetch: Fetch = (input, init) => fetch(input, init)

export function toolConfig(): Config {
  return readConfig({ ...process.env })
}

export function toolClients(config: Config): {
  rxnorm: RxNormClient
  openfda: OpenFdaClient
  judge: Judge
} {
  if (config.typesafeApiKey === null) {
    throw new Error('TYPESAFE_API_KEY is not set. Add it to apps/worker/.dev.vars.')
  }
  return {
    rxnorm: new RxNormClient({ baseUrl: config.rxnormBaseUrl, fetch: globalFetch }),
    // Fresh lookups, not the Worker's 24-hour cache: the batch should see today's labels.
    openfda: new OpenFdaClient(
      { baseUrl: config.openfdaBaseUrl, fetch: globalFetch },
      config.openfdaApiKey,
    ),
    judge: new Judge(
      new TypeSafeClient({
        apiKey: config.typesafeApiKey,
        timeout: 60_000,
        retry: { maxRetries: 2 },
        logLevel: 'warn',
      }),
      config.typesafeModel,
    ),
  }
}
