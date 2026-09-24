import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Default export required by Vitest. Two projects: most tests run inside the Workers
// runtime with local D1, KV and Durable Objects; tests of the Node tools, and the golden
// check over the whole local store, run in Node.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: { name: 'workers', include: ['test/**/*.test.ts'], exclude: ['test/node/**'] },
      },
      {
        test: { name: 'node', include: ['test/node/**/*.test.ts'], environment: 'node' },
      },
    ],
  },
})
