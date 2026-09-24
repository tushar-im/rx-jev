import { type AskResponse, AskRequestSchema, type CustomAnswer } from '@rx-jev/contract'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { buildCustomRequest, CUSTOM, questionKey } from '../judge.ts'
import { canonicalLabels, type Lookup } from '../lookup.ts'
import { ProblemError, parseOr422 } from '../problems.ts'
import { candidateTrace, evidenceView, isConfident, stanceView } from '../views.ts'
import { labelInfo, RxCuiParams } from './labels.ts'

// What one label says about a reader's own question, asked live.
//
// The question becomes part of the Jev instructions (`buildCustomRequest`); the five answer
// categories and the verbatim-quote rule stay the same as for catalog questions. Custom
// answers are never stored and never reviewed, so every ask calls Jev, which is why asks
// are limited in length and rate per client.

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ProblemError(422, 'Invalid request: body')
  }
}

function duration(seconds: number): string {
  const unit = (n: number, name: string) => (n === 1 ? `1 ${name}` : `${n} ${name}s`)
  if (seconds < 60) return unit(seconds, 'second')
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return unit(minutes, 'minute')
  return unit(Math.ceil(minutes / 60), 'hour')
}

function refuse(wait: number): never {
  const seconds = Math.max(1, Math.ceil(wait))
  throw new ProblemError(429, `Too many questions. Try again in ${duration(seconds)}.`, {
    'Retry-After': String(seconds),
  })
}

export const askRoutes = new Hono<AppEnv>().post('/:rxcui/ask', async (c) => {
  const { rxcui } = parseOr422(RxCuiParams, c.req.param(), 'path')
  const body = parseOr422(AskRequestSchema, await readBody(c.req.raw), 'body')
  const { rxnorm, openfda, judge, config, askLimiter } = c.var.services

  // The ask takes its slot before any upstream call, so a burst cannot all reach RxNorm and
  // openFDA at once. An ask whose drug or label is not found gives back its own slot.
  const client = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const slot = await askLimiter.acquire(client)
  if (typeof slot === 'number') refuse(slot)

  let lookup: Lookup
  let label: Lookup['labels'][number]
  try {
    lookup = await canonicalLabels(rxcui, rxnorm, openfda)
    const found = lookup.labels.find((l) => l.set_id === body.set_id)
    if (found === undefined) {
      throw new ProblemError(404, `Label ${body.set_id} is not a current label of this drug.`)
    }
    label = found
  } catch (error) {
    if (error instanceof ProblemError && error.status === 404) await askLimiter.release(slot)
    throw error
  }

  const request = await buildCustomRequest(label, body.question)
  const skipped = request.skipped[CUSTOM]
  if (skipped !== undefined) {
    const answer: CustomAnswer = {
      question: body.question,
      status: skipped,
      reviewed: false,
      confident: false,
      stance: null,
      evidence: null,
      candidates: 0,
      sections: [],
    }
    return c.json<AskResponse>({
      rxcui,
      label: labelInfo(label),
      model_version: null,
      input_tokens: null,
      output_tokens: null,
      latency_ms: null,
      answer,
      sources: lookup.sources,
    })
  }

  const result = await judge.judge(request)
  const stance = result.distributions[questionKey(CUSTOM, 'stance')]
  const evidence = result.distributions[questionKey(CUSTOM, 'evidence')]
  const candidates = request.asked[CUSTOM] ?? []
  if (!stance || !evidence) throw new Error('Jev returned no custom answer.')
  return c.json<AskResponse>({
    rxcui,
    label: labelInfo(label),
    model_version: result.model_version,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    latency_ms: result.latency_ms,
    answer: {
      question: body.question,
      status: 'judged',
      reviewed: false,
      confident: isConfident(stance, evidence, config.displayMinConfidence),
      stance: stanceView(stance),
      evidence: evidenceView(candidates, evidence),
      ...candidateTrace(candidates),
    },
    sources: lookup.sources,
  })
})
