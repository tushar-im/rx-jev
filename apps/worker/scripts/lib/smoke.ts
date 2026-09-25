import { z } from 'zod'
import type { Fetch } from '../../src/http.ts'

// The cutover smoke test (M6.11): the deployed site answers, and the demo drugs load from
// the imported store without calling Jev. A label judged now means its stored run was not
// found, so its prompt hash or label version differs from the store.

export const SMOKE_DRUGS = ['Tylenol PM', 'Wellbutrin', 'Benadryl']

export type AccessToken = { id: string; secret: string }

const Resolved = z.object({ rxcui: z.string() })
const Answers = z.object({
  labels: z.array(z.object({ product_type: z.string(), version: z.string(), fresh: z.boolean() })),
})

export async function smoke(
  baseUrl: string,
  fetch: Fetch,
  token?: AccessToken,
): Promise<{ ok: boolean; lines: string[] }> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  // A Cloudflare Access service token lets a script through Access.
  if (token) {
    headers['CF-Access-Client-Id'] = token.id
    headers['CF-Access-Client-Secret'] = token.secret
  }
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(new URL(path, baseUrl).toString(), { headers })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response.json()
  }

  const lines: string[] = []
  let ok = true
  try {
    await get('/api/health')
    lines.push('health: ok')
  } catch (error) {
    return { ok: false, lines: [`health: ${String(error)}`] }
  }
  for (const name of SMOKE_DRUGS) {
    try {
      const { rxcui } = Resolved.parse(await get(`/api/drugs/resolve?name=${encodeURIComponent(name)}`))
      const { labels } = Answers.parse(await get(`/api/labels/${rxcui}/answers`))
      const parts = labels.map(
        (l) => `${l.product_type} v${l.version} ${l.fresh ? 'judged now' : 'from the store'}`,
      )
      if (labels.some((l) => l.fresh)) ok = false
      lines.push(`${name}: ${parts.join(', ')}`)
    } catch (error) {
      ok = false
      lines.push(`${name}: ${String(error)}`)
    }
  }
  return { ok, lines }
}
