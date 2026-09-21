import { z } from 'zod'

// Every response from the backend is parsed with zod before the UI touches it.

export const HealthSchema = z.object({ status: z.literal('ok') })
export type Health = z.infer<typeof HealthSchema>

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
})
export type Problem = z.infer<typeof ProblemSchema>

export class ApiError extends Error {
  readonly problem: Problem

  constructor(problem: Problem) {
    super(problem.detail)
    this.problem = problem
  }
}

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } })
  const body: unknown = await response.json()
  if (!response.ok) {
    const problem = ProblemSchema.safeParse(body)
    throw new ApiError(
      problem.success
        ? problem.data
        : { type: 'about:blank', title: 'Error', status: response.status, detail: 'Unexpected error' },
    )
  }
  return schema.parse(body)
}

export function fetchHealth(): Promise<Health> {
  return getJson('/api/health', HealthSchema)
}
