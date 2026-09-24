import type { AnswersResponse } from '@rx-jev/contract'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { judgeLabels } from '../answering.ts'
import { canonicalLabels } from '../lookup.ts'
import { parseOr422 } from '../problems.ts'
import { labelAnswers } from '../views.ts'
import { RxCuiParams } from './labels.ts'

// What each canonical label says about every catalog question, served from the store.
//
// A store miss judges every standard question for that label version and stores the result
// before serving it (see `judgeLabels`). A Jev failure returns 503 and stores nothing.
// Answers are never partial or guessed.

export const answerRoutes = new Hono<AppEnv>().get('/:rxcui/answers', async (c) => {
  const { rxcui } = parseOr422(RxCuiParams, c.req.param(), 'path')
  const { rxnorm, openfda, judge, store, config } = c.var.services
  const lookup = await canonicalLabels(rxcui, rxnorm, openfda)
  const judged = await judgeLabels(lookup.labels, judge, store)
  return c.json<AnswersResponse>({
    rxcui,
    ingredients: lookup.ingredients,
    labels: judged.map((j) => labelAnswers(j, config.displayMinConfidence)),
    sources: lookup.sources,
  })
})
