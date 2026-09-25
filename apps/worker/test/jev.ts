import { TypeSafeClient } from '@typesafe-ai/sdk'

// A stand-in for the TypeSafe API. Unit tests never call the real Jev. FakeJev answers every
// Choice question with a peaked distribution over its criteria and records each request
// body, so tests can check what was sent.

export const MODEL_VERSION = 'jev-1.13.0'

/** Picks the option to peak on, given the question key and its option names. */
export type Picker = (key: string, options: string[]) => string

export type SentBody = {
  model: string
  state: { drug_label: { sections: Record<string, Record<string, unknown>> } } & Record<
    string,
    unknown
  >
  questions: Record<
    string,
    { type: string; instructions: Record<string, unknown>; criteria: Record<string, unknown> }
  >
}

type FakeJevOptions = {
  pick?: Picker
  status?: number
  // Question keys to leave unanswered.
  drop?: Set<string>
  // Confidence per question key; 0.8 for every question unless given.
  confidence?: (key: string) => number
}

export class FakeJev {
  pick: Picker
  status: number
  drop: Set<string>
  confidence: (key: string) => number
  readonly requests: SentBody[] = []

  constructor(options: FakeJevOptions = {}) {
    this.pick = options.pick ?? ((_key, options) => options[0] ?? '')
    this.status = options.status ?? 200
    this.drop = options.drop ?? new Set()
    this.confidence = options.confidence ?? (() => 0.8)
  }

  client(): TypeSafeClient {
    return new TypeSafeClient({
      apiKey: 'test-key',
      baseURL: 'https://jev.test',
      fetch: (_input, init) => this.handle(init),
      retry: { maxRetries: 0 },
      logLevel: 'off',
    })
  }

  /** Answers one request; subclasses may change `status` first. */
  async handle(init: RequestInit | undefined): Promise<Response> {
    const body = JSON.parse(String(init?.body)) as SentBody
    this.requests.push(body)
    if (this.status !== 200) return respond(this.status, { error: 'overloaded' })
    const answers: Record<string, unknown> = {}
    for (const [key, question] of Object.entries(body.questions)) {
      if (!this.drop.has(key)) answers[key] = this.answer(key, Object.keys(question.criteria))
    }
    return respond(200, {
      model: MODEL_VERSION,
      answers,
      usage: { input_tokens: 1234, output_tokens: 56 },
    })
  }

  answer(key: string, options: string[]): Record<string, unknown> {
    const choice = this.pick(key, options)
    const rest = options.filter((o) => o !== choice)
    const probabilities: Record<string, number> = {}
    for (const o of rest) probabilities[o] = 0.1 / rest.length
    probabilities[choice] = 0.9
    return { type: 'choice', choice, probabilities, confidence: this.confidence(key) }
  }
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
