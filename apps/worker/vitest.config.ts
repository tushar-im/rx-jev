import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))

// Default export required by Vitest. Two projects: most tests run inside the Workers
// runtime with local D1, KV and Durable Objects; tests of the Node tools, and the golden
// check over the whole local store, run in Node.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/**/*.test.ts'],
          exclude: ['test/node/**'],
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        test: { name: 'node', include: ['test/node/**/*.test.ts'], environment: 'node' },
      },
    ],
  },
})
