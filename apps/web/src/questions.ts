import type { Answer } from './api.ts'

// The five answer categories do not fit food instructions (Gate 1), so this question stays
// hidden until it has its own options.
const HIDDEN_QUESTIONS = new Set(['take_with_food'])

export function visibleAnswers(answers: Answer[]): Answer[] {
  return answers.filter((a) => !HIDDEN_QUESTIONS.has(a.question_id))
}
