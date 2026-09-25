import type {
  Answer,
  AskResponse,
  CustomAnswer,
  Group,
  LabelAnswers,
  SourceTrace,
  LabelOverview,
} from './api.ts'

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
    candidates: 38,
    sections: ['pregnancy_or_breast_feeding', 'do_not_use'],
    ...overrides,
  }
}

/** The overview of the Advil OTC label in `labelAnswers`. */
export function labelOverview(): LabelOverview {
  return {
    boxed_warning: null,
    purpose: { section: 'purpose', heading: 'Purpose', text: 'Pain reliever/fever reducer' },
    uses: {
      section: 'indications_and_usage',
      heading: 'Uses',
      text: 'temporarily relieves minor aches and pains due to: headache toothache backache',
    },
    // No heading of its own, so the caption is the section's name.
    strengths: {
      section: 'active_ingredient',
      heading: null,
      text: 'Active ingredient (in each tablet) Ibuprofen 200 mg (NSAID)*',
    },
  }
}

export function labelAnswers(overrides: Partial<LabelAnswers> = {}): LabelAnswers {
  return {
    set_id: '0ca02f8b-4413-4e7c-a67b-8c67c53e1343',
    version: '5',
    effective_time: '2026-09-09',
    product_type: 'otc',
    layout: 'otc',
    brand_name: 'Advil',
    manufacturer_name: 'Haleon US Holdings LLC',
    dailymed_url:
      'https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=0ca02f8b-4413-4e7c-a67b-8c67c53e1343',
    model_version: 'jev-1.13.0',
    judged_at: '2026-09-21T10:00:00Z',
    input_tokens: 10968,
    output_tokens: 56,
    latency_ms: 910,
    fresh: false,
    overview: labelOverview(),
    answers: QUESTIONS.map(([id]) => answer(id)),
    ...overrides,
  }
}

export function customAnswer(overrides: Partial<CustomAnswer> = {}): CustomAnswer {
  const { question_id: _id, group: _group, title: _title, ...judged } = answer('pregnancy')
  return {
    ...judged,
    question: 'Can I take it with grapefruit juice?',
    reviewed: false,
    ...overrides,
  }
}

export function askResponse(overrides: Partial<CustomAnswer> = {}): AskResponse {
  const {
    answers: _answers,
    model_version: _model,
    judged_at: _judged,
    input_tokens: _in,
    output_tokens: _out,
    latency_ms: _latency,
    fresh: _fresh,
    overview: _overview,
    ...label
  } = labelAnswers()
  return {
    rxcui: '5640',
    label,
    model_version: 'jev-1.13.0',
    input_tokens: 2105,
    output_tokens: 56,
    latency_ms: 640,
    answer: customAnswer(overrides),
    sources: sourceTrace(),
  }
}

export function sourceTrace(overrides: Partial<SourceTrace> = {}): SourceTrace {
  return {
    rxnorm_ms: 310,
    openfda_ms: 820,
    openfda_requests: 2,
    openfda_cached: false,
    openfda_stale: false,
    openfda_fetched_at: null,
    matches: {
      otc: { total: 831, original_packager: true },
      prescription: { total: 47, original_packager: true },
    },
    ...overrides,
  }
}
