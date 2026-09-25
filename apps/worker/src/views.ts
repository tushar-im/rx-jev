import {
  type Answer,
  type EvidenceView,
  type LabelAnswers,
  type LabelOverview,
  type LabelText,
  type StanceView,
  StanceViewSchema,
} from '@rx-jev/contract'
import type { JudgedLabel } from './answering.ts'
import { CATALOG, labelFormat, type Question } from './catalog.ts'
import type { Label } from './clients/openfda.ts'
import { type Distribution, NONE, questionKey } from './judge.ts'
import { isBlank } from './python.ts'
import { labelInfo } from './routes/labels.ts'
import type { Candidate } from './sentences.ts'

// Answers as the API serves them. The display threshold agreed at Gate 1 is applied here,
// at read time, as `confident`, so it can change without re-running inference.

export function labelAnswers(judged: JudgedLabel, minConfidence: number): LabelAnswers {
  const { label, run } = judged
  return {
    ...labelInfo(label),
    model_version: run?.model_version ?? null,
    judged_at: run?.created_at ?? null,
    input_tokens: run?.input_tokens ?? null,
    output_tokens: run?.output_tokens ?? null,
    latency_ms: run?.latency_ms ?? null,
    fresh: judged.fresh,
    overview: labelOverview(label),
    answers: CATALOG.map((q) => answer(q, judged, minConfidence)),
  }
}

// The heading a label prints at the start of an overview section, such as "Purposes",
// "USE(S)", "1 INDICATIONS AND USAGE" or "Active ingredient (in each tablet)". A heading must
// end at a word boundary, and a lone "Use" only counts before a colon, so the first word of
// a sentence ("Use in children…") is never taken for one.
const NUMBER = String.raw`(?:\d+(?:\.\d+)*\.?\s+)?`
const HEADINGS: Record<string, RegExp> = {
  purpose: /^purposes?(?:\s*\(s\))?(?![A-Za-z])/i,
  indications_and_usage: new RegExp(
    `^${NUMBER}(?:indications?(?:\\s+(?:and|&)\\s+usage)?|uses?\\s*\\(s\\)|uses|use(?=\\s*:))(?![A-Za-z])`,
    'i',
  ),
  active_ingredient: /^active\s+ingredients?(?:\s*\([^)]*\))?(?![A-Za-z])/i,
  dosage_forms_and_strengths: new RegExp(
    `^${NUMBER}dosage\\s+forms?\\s+(?:and|&)\\s+strengths?(?![A-Za-z])`,
    'i',
  ),
}
// What may sit between a heading and the text: spaces, a colon, a dash or a full stop.
const SEPARATOR = /^[\s:.\u2013-]*/

/**
 * A section split into the label's own heading and the text after it, both verbatim. A
 * heading printed twice ("Purpose Purpose …") is dropped both times. Without a heading, or
 * with nothing after it, the whole section is the text.
 */
function splitHeading(name: string, whole: string): LabelText {
  const pattern = HEADINGS[name]
  const start = whole.length - whole.trimStart().length
  const match = pattern?.exec(whole.slice(start))
  if (!pattern || !match) return { section: name, heading: null, text: whole }
  const heading = match[0]
  let at = start + heading.length
  for (;;) {
    at += SEPARATOR.exec(whole.slice(at))?.[0].length ?? 0
    const again = pattern.exec(whole.slice(at))
    if (!again || again[0].toLowerCase() !== heading.toLowerCase()) break
    at += again[0].length
  }
  const text = whole.slice(at)
  if (isBlank(text)) return { section: name, heading: null, text: whole }
  return { section: name, heading, text }
}

/** The first of `sections` the label has with text, verbatim, split from its heading. */
function section(label: Label, ...sections: string[]): LabelText | null {
  for (const name of sections) {
    const text = label.sections[name]
    if (text !== undefined && !isBlank(text)) return splitHeading(name, text)
  }
  return null
}

/**
 * The label sections shown before a question is picked. OTC sections are shown by the
 * label's layout, as the catalog reads it, since some labels marked prescription use the
 * OTC Drug Facts layout.
 */
export function labelOverview(label: Label): LabelOverview {
  const otc = labelFormat(label) === 'otc'
  return {
    boxed_warning: section(label, 'boxed_warning'),
    purpose: otc ? section(label, 'purpose') : null,
    uses: section(label, 'indications_and_usage'),
    strengths: otc
      ? section(label, 'active_ingredient')
      : section(label, 'dosage_forms_and_strengths'),
  }
}

/** How many sentences a question offered Jev, and their sections in label order. */
export function candidateTrace(candidates: Candidate[]): {
  candidates: number
  sections: string[]
} {
  return {
    candidates: candidates.length,
    sections: [...new Set(candidates.map((c) => c.section))],
  }
}

/** Whether a category may be shown: a real quote and both confidences at the threshold. */
export function isConfident(
  stance: Distribution,
  evidence: Distribution,
  minConfidence: number,
): boolean {
  return (
    evidence.choice !== NONE && Math.min(stance.confidence, evidence.confidence) >= minConfidence
  )
}

export function stanceView(distribution: Distribution): StanceView {
  return StanceViewSchema.parse(distribution)
}

export function evidenceView(candidates: Candidate[], distribution: Distribution): EvidenceView {
  const chosen = distribution.choice
  const candidate = candidates.find((c) => c.id === chosen)
  if (candidate === undefined && chosen !== NONE) {
    throw new Error(`Stored evidence ${chosen} is not a candidate of this label version.`)
  }
  return {
    choice: chosen,
    confidence: distribution.confidence,
    probability: distribution.probabilities[chosen] ?? 0,
    quote: candidate
      ? {
          section: candidate.section,
          text: candidate.text,
          lead_in: candidate.lead_in?.text ?? null,
        }
      : null,
  }
}

function answer(question: Question, judged: JudgedLabel, minConfidence: number): Answer {
  const { request, run } = judged
  const base = { question_id: question.id, group: question.group, title: question.title }
  const skipped = request.skipped[question.id]
  if (skipped !== undefined) {
    return {
      ...base,
      status: skipped,
      reviewed: false,
      confident: false,
      stance: null,
      evidence: null,
      candidates: 0,
      sections: [],
    }
  }
  const stance = run?.judgments[questionKey(question.id, 'stance')]
  const evidence = run?.judgments[questionKey(question.id, 'evidence')]
  const candidates = request.asked[question.id]
  if (!stance || !evidence || !candidates) {
    throw new Error(`No stored judgment for judged question ${question.id}.`)
  }
  return {
    ...base,
    status: 'judged',
    reviewed: stance.reviewed && evidence.reviewed,
    confident: isConfident(stance.distribution, evidence.distribution, minConfidence),
    stance: stanceView(stance.distribution),
    evidence: evidenceView(candidates, evidence.distribution),
    ...candidateTrace(candidates),
  }
}
