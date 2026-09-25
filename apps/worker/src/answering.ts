import type { Label } from './clients/openfda.ts'
import { buildRequest, type Judge, type JudgeRequest, type JudgeResult } from './judge.ts'
import type { Store, StoredRun } from './store.ts'

// Makes sure every label has stored judgments, judging only the ones the store lacks.

export type JudgedLabel = {
  label: Label
  request: JudgeRequest
  // Null only when no question had candidates, so there was nothing to ask Jev.
  run: StoredRun | null
  // True when this call judged the label; false when it came from the store.
  fresh: boolean
}

/**
 * Stored judgments for every label. Raises JudgeError and stores nothing if Jev fails.
 *
 * Every miss is judged before any result is stored, so a failure on a later label never
 * leaves an earlier label of the same drug stored on its own.
 */
export async function judgeLabels(
  labels: Label[],
  judge: Judge,
  store: Store,
): Promise<JudgedLabel[]> {
  const found = await Promise.all(
    labels.map(async (label) => {
      const request = await buildRequest(label)
      const run = await store.find(label, request.promptHash, judge.model)
      return { label, request, run }
    }),
  )
  const results: (JudgeResult | null)[] = []
  for (const { request, run } of found) {
    const due = run === null && Object.keys(request.questions).length > 0
    results.push(due ? await judge.judge(request) : null)
  }
  const judged: JudgedLabel[] = []
  for (const [i, { label, request, run }] of found.entries()) {
    const result = results[i] ?? null
    judged.push({
      label,
      request,
      run: result ? await store.save(label, request, judge.model, result) : run,
      fresh: result !== null,
    })
  }
  return judged
}
