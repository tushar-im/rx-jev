import type { Answer, CustomAnswer, Group } from './api.ts'

export const GROUP_TITLES: Record<Group, string> = {
  who: 'Who is taking it',
  conditions: 'Health conditions',
  combinations: 'Taken with',
  daily_life: 'Daily life',
  serious: 'Serious warnings',
}

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
