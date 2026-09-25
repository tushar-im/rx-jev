import { expect } from 'vitest'
import { LabelSchema } from '../src/clients/openfda.ts'
import {
  buildCustomRequest,
  buildRequest,
  type Distribution,
  estimateTokens,
  hashParts,
  type JudgeRequest,
  partBody,
  shortlistPart,
} from '../src/judge.ts'
import { splitSection } from '../src/sentences.ts'

// Checks the TypeScript request builder against golden files written by the retired Python
// app (scripts/write_golden.py, removed in M6.11 and kept in the Git history). Stored
// judgments are keyed by prompt hash, so any difference would re-judge stored labels.

type RequestGolden = {
  prompt_hash: string
  skipped: Record<string, string>
  asked: Record<string, string[]>
  evidence_chunks: Record<string, string[][]>
  parts: { hash: string; estimate: number }[]
  bodies?: unknown[]
}

export type LabelGolden = {
  label: Record<string, unknown> & { set_id: string }
  candidates: Record<string, { id: string; text: string; lead_in: string | null }[]>
  requests: Record<string, RequestGolden>
  custom: RequestGolden
}

export type GoldenFile = {
  custom_question: string
  labels: LabelGolden[]
  shortlist: {
    set_id: string
    answers: Record<string, Distribution>
    hash: string
    body: unknown
  }
}

async function summary(request: JudgeRequest, bodies: boolean): Promise<RequestGolden> {
  const golden: RequestGolden = {
    prompt_hash: request.promptHash,
    skipped: request.skipped,
    asked: Object.fromEntries(
      Object.entries(request.asked).map(([q, cs]) => [q, cs.map((c) => c.id)]),
    ),
    evidence_chunks: Object.fromEntries(
      Object.entries(request.evidenceChunks).map(([q, spec]) => [q, spec.chunks]),
    ),
    parts: await Promise.all(
      request.parts.map(async (p) => ({
        hash: await hashParts([p]),
        estimate: estimateTokens(p.state, p.questions),
      })),
    ),
  }
  if (bodies) golden.bodies = request.parts.map(partBody)
  return golden
}

function withoutBodies(golden: RequestGolden, bodies: boolean): RequestGolden {
  if (bodies) return golden
  const { bodies: _bodies, ...rest } = golden
  return rest
}

export async function checkLabel(
  entry: LabelGolden,
  customQuestion: string,
  { bodies }: { bodies: boolean },
): Promise<void> {
  const label = LabelSchema.parse(entry.label)
  const where = `${label.set_id} v${label.version}`

  const candidates = Object.fromEntries(
    Object.entries(label.sections).map(([name, text]) => [
      name,
      splitSection(name, text).map((c) => ({
        id: c.id,
        text: c.text,
        lead_in: c.lead_in?.text ?? null,
      })),
    ]),
  )
  expect(candidates, `${where}: candidates`).toEqual(entry.candidates)

  for (const [budget, expected] of Object.entries(entry.requests)) {
    const request = await buildRequest(label, Number(budget))
    expect(await summary(request, bodies), `${where}: request at ${budget}`).toEqual(
      withoutBodies(expected, bodies),
    )
  }
  const custom = await buildCustomRequest(label, customQuestion)
  expect(await summary(custom, bodies), `${where}: custom request`).toEqual(
    withoutBodies(entry.custom, bodies),
  )
}

export async function checkShortlist(file: GoldenFile): Promise<void> {
  const entry = file.labels.find((g) => g.label.set_id === file.shortlist.set_id)
  if (!entry) throw new Error('The shortlist label is missing from the golden file')
  const request = await buildRequest(LabelSchema.parse(entry.label))
  const part = shortlistPart(request, file.shortlist.answers)

  expect(partBody(part)).toEqual(file.shortlist.body)
  expect(await hashParts([part])).toBe(file.shortlist.hash)
}
