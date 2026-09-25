import {
  type AnswersResponse,
  AnswersResponseSchema,
  type AskResponse,
  AskResponseSchema,
  type Health,
  HealthSchema,
  type Problem,
  ProblemSchema,
  type ResolvedDrug,
  ResolvedDrugSchema,
  type Suggestions,
  SuggestionsSchema,
} from '@rx-jev/contract'
import type { z } from 'zod'

// The API client. Every response is parsed with the shared contract before the UI touches it.

export * from '@rx-jev/contract'

export class ApiError extends Error {
  readonly problem: Problem

  constructor(problem: Problem) {
    super(problem.detail)
    this.problem = problem
  }
}

async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  return requestJson(path, schema, { headers: { Accept: 'application/json' }, signal })
}

async function postJson<T>(
  path: string,
  payload: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  return requestJson(path, schema, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
}

async function requestJson<T>(path: string, schema: z.ZodType<T>, init: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body: unknown = await response.json()
  if (!response.ok) {
    const problem = ProblemSchema.safeParse(body)
    throw new ApiError(
      problem.success
        ? problem.data
        : {
            type: 'about:blank',
            title: 'Error',
            status: response.status,
            detail: 'Unexpected error',
          },
    )
  }
  return schema.parse(body)
}

export function fetchHealth(): Promise<Health> {
  return getJson('/api/health', HealthSchema)
}

export function fetchSuggestions(query: string, signal?: AbortSignal): Promise<Suggestions> {
  const params = new URLSearchParams({ q: query })
  return getJson(`/api/drugs/suggestions?${params}`, SuggestionsSchema, signal)
}

export function resolveDrug(name: string): Promise<ResolvedDrug> {
  const params = new URLSearchParams({ name })
  return getJson(`/api/drugs/resolve?${params}`, ResolvedDrugSchema)
}

export function fetchAnswers(rxcui: string, signal?: AbortSignal): Promise<AnswersResponse> {
  return getJson(`/api/labels/${encodeURIComponent(rxcui)}/answers`, AnswersResponseSchema, signal)
}

export function askLabel(
  rxcui: string,
  setId: string,
  question: string,
  signal?: AbortSignal,
): Promise<AskResponse> {
  return postJson(
    `/api/labels/${encodeURIComponent(rxcui)}/ask`,
    { set_id: setId, question },
    AskResponseSchema,
    signal,
  )
}
