import type { AnswersResponse } from '@rx-jev/contract'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { type JudgedLabel, judgeLabels } from '../answering.ts'
import { canonicalLabels } from '../lookup.ts'
import { parseOr422 } from '../problems.ts'
import { labelAnswers } from '../views.ts'
import { RxCuiParams } from './labels.ts'

// What each canonical label says about every catalog question, served from the store.
//
// A store miss judges every standard question for that label version and stores the result
// before serving it (see `judgeLabels`). A Jev failure returns 503 and stores nothing.
// Answers are never partial or guessed.
//
// Stored answers carry a weak ETag from the label versions, their runs and the display
// threshold, so a browser can revalidate them for a 304. Answers judged by this request
// are never cached: their trace describes a Jev call that must not be counted twice.

async function answersTag(judged: JudgedLabel[], minConfidence: number): Promise<string> {
  const parts = judged.map((j) => [
    j.label.set_id,
    j.label.version,
    j.request.promptHash,
    j.run?.id ?? null,
  ])
  const bytes = new TextEncoder().encode(JSON.stringify([minConfidence, parts]))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `W/"${hex}"`
}

export const answerRoutes = new Hono<AppEnv>().get('/:rxcui/answers', async (c) => {
  const { rxcui } = parseOr422(RxCuiParams, c.req.param(), 'path')
  const { rxnorm, openfda, judge, store, config } = c.var.services
  const lookup = await canonicalLabels(rxcui, rxnorm, openfda)
  const judged = await judgeLabels(lookup.labels, judge, store)

  if (judged.some((j) => j.fresh)) {
    c.header('Cache-Control', 'no-store')
  } else {
    const etag = await answersTag(judged, config.displayMinConfidence)
    c.header('ETag', etag)
    c.header('Cache-Control', 'private, no-cache')
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
  }
  return c.json<AnswersResponse>({
    rxcui,
    ingredients: lookup.ingredients,
    labels: judged.map((j) => labelAnswers(j, config.displayMinConfidence)),
    sources: lookup.sources,
  })
})
