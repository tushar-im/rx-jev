import type { Answer, Group, LabelAnswers } from './api.ts'

// Test data shaped like the API's answers response. Label text here is public label
// wording, never patient data.

const QUESTIONS: [id: string, group: Group, title: string][] = [
  ['pregnancy', 'who', 'Pregnancy'],
  ['breastfeeding', 'who', 'Breastfeeding'],
  ['children', 'who', 'Children'],
  ['older_adults', 'who', 'Older adults'],
  ['diabetes', 'conditions', 'Diabetes'],
  ['kidney', 'conditions', 'Kidney disease'],
  ['alcohol', 'combinations', 'Alcohol'],
  ['blood_thinners', 'combinations', 'Blood thinners'],
  ['drowsiness_driving', 'daily_life', 'Drowsiness and driving'],
  ['take_with_food', 'daily_life', 'Taking with food'],
  ['boxed_warning', 'serious', 'Boxed warning'],
  ['allergy', 'serious', 'Allergy warnings'],
]

export function answer(questionId: string, overrides: Partial<Answer> = {}): Answer {
  const question = QUESTIONS.find(([id]) => id === questionId)
  if (!question) throw new Error(`Unknown test question ${questionId}`)
  const [, group, title] = question
  return {
    question_id: questionId,
    group,
    title,
    status: 'judged',
    reviewed: false,
    confident: true,
    stance: {
      choice: 'caution',
      confidence: 0.95,
      probabilities: {
        warns_against: 0.02,
        caution: 0.95,
        dose_change: 0.01,
        no_known_issue: 0.01,
        not_mentioned: 0.01,
      },
    },
    evidence: {
      choice: 's3',
      confidence: 0.93,
      probability: 0.93,
      quote: {
        section: 'pregnancy_or_breast_feeding',
        text: 'ask a health professional before use.',
        lead_in: 'If pregnant or breast-feeding,',
      },
    },
    ...overrides,
  }
}

export function labelAnswers(overrides: Partial<LabelAnswers> = {}): LabelAnswers {
  return {
    set_id: '0ca02f8b-4413-4e7c-a67b-8c67c53e1343',
    version: '5',
    effective_time: '2026-09-09',
    product_type: 'otc',
    brand_name: 'Advil',
    manufacturer_name: 'Haleon US Holdings LLC',
    dailymed_url:
      'https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=0ca02f8b-4413-4e7c-a67b-8c67c53e1343',
    answers: QUESTIONS.map(([id]) => answer(id)),
    ...overrides,
  }
}
