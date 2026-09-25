// Smoke-test a deployment (M6.11).
//
//   node scripts/smoke.ts https://rx-jev.example.com
//
// Behind Cloudflare Access, set ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET from a service
// token. Exits non-zero if the site fails or any demo drug had to be judged now.

import { type AccessToken, smoke } from './lib/smoke.ts'

const baseUrl = process.argv[2]
if (!baseUrl) throw new Error('Usage: node scripts/smoke.ts <https://your-site>')
const id = process.env.ACCESS_CLIENT_ID
const secret = process.env.ACCESS_CLIENT_SECRET
const token: AccessToken | undefined = id && secret ? { id, secret } : undefined

const result = await smoke(baseUrl, (input, init) => fetch(input, init), token)
for (const line of result.lines) console.log(line)
console.log(result.ok ? 'Smoke test passed.' : 'Smoke test FAILED.')
if (!result.ok) process.exitCode = 1
