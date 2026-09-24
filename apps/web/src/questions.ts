import type { Answer, CustomAnswer } from './api.ts'

// The five answer categories do not fit food instructions (Gate 1), so this question stays
// hidden until it has its own options.
const HIDDEN_QUESTIONS = new Set(['take_with_food'])

export function visibleAnswers(answers: Answer[]): Answer[] {
  return answers.filter((a) => !HIDDEN_QUESTIONS.has(a.question_id))
}

// Whether the card shows a category and quote for this answer, rather than "no clear
// answer". It says nothing about which category.
export function hasClearAnswer(answer: Answer | CustomAnswer): boolean {
  return answer.confident && answer.stance !== null && Boolean(answer.evidence?.quote)
}
