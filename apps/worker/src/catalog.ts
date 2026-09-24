import type { Group, Layout } from '@rx-jev/contract'
import type { Label } from './clients/openfda.ts'
import { isBlank } from './python.ts'

// The v1 question catalog and which label sections may answer each question.
//
// Code, not the model, decides the candidate sections. The mapper reads the sections a label
// actually has, because product type metadata is not reliable: some repackager labels marked
// prescription use the OTC Drug Facts layout, and older prescription labels predate the PLR
// layout and use `warnings` and `precautions` instead of `warnings_and_cautions`.

export const QUESTION_IDS = [
  'pregnancy',
  'breastfeeding',
  'children',
  'older_adults',
  'diabetes',
  'high_blood_pressure',
  'kidney',
  'liver',
  'heart',
  'asthma',
  'glaucoma',
  'enlarged_prostate',
  'stomach_ulcers',
  'alcohol',
  'blood_thinners',
  'drowsiness_driving',
  'take_with_food',
  'boxed_warning',
  'allergy',
] as const
export type QuestionId = (typeof QUESTION_IDS)[number]

export type Question = {
  id: QuestionId
  group: Group
  title: string
  // What Jev is asked about, phrased to fit "what does this label say about <subject>".
  // Question IDs are never sent to the model, so this carries the full meaning.
  subject: string
  // Candidate sections in priority order, per label layout. Old-layout prescription
  // fallbacks sit next to their PLR equivalents; absent sections are skipped.
  otcSections: readonly string[]
  prescriptionSections: readonly string[]
  // Extra rules for this question's stance, added to the shared reading rules.
  stanceRules: readonly string[]
}

// Sections that only appear in the OTC Drug Facts layout.
const OTC_MARKERS = [
  'do_not_use',
  'ask_doctor',
  'ask_doctor_or_pharmacist',
  'when_using',
  'stop_use',
  'pregnancy_or_breast_feeding',
]

const CONDITION_OTC = ['do_not_use', 'ask_doctor', 'warnings']
const CONDITION_RX = [
  'contraindications',
  'warnings_and_cautions',
  'warnings',
  'precautions',
  'use_in_specific_populations',
]

function question(q: Omit<Question, 'stanceRules'> & { stanceRules?: string[] }): Question {
  return { stanceRules: [], ...q }
}

function condition(id: QuestionId, title: string, subject: string): Question {
  return question({
    id,
    group: 'conditions',
    title,
    subject,
    otcSections: CONDITION_OTC,
    prescriptionSections: CONDITION_RX,
  })
}

export const CATALOG: readonly Question[] = [
  question({
    id: 'pregnancy',
    subject: 'use during pregnancy',
    group: 'who',
    title: 'Pregnancy',
    otcSections: ['pregnancy_or_breast_feeding'],
    prescriptionSections: ['pregnancy', 'use_in_specific_populations'],
  }),
  question({
    id: 'breastfeeding',
    subject: 'use while breastfeeding',
    group: 'who',
    title: 'Breastfeeding',
    otcSections: ['pregnancy_or_breast_feeding'],
    prescriptionSections: ['nursing_mothers', 'use_in_specific_populations'],
  }),
  question({
    id: 'children',
    subject: 'use in children',
    group: 'who',
    title: 'Children',
    otcSections: ['do_not_use', 'dosage_and_administration'],
    prescriptionSections: ['pediatric_use'],
    // Agreed at Gate 1: unestablished safety tells parents something, so it is not silence.
    stanceRules: [
      'A statement that safety or effectiveness in children or pediatric patients has ' +
        'not been established is `caution`, not `not_mentioned`.',
    ],
  }),
  question({
    id: 'older_adults',
    subject: 'use in older adults',
    group: 'who',
    title: 'Older adults',
    otcSections: ['ask_doctor', 'dosage_and_administration'],
    prescriptionSections: ['geriatric_use'],
  }),
  condition('diabetes', 'Diabetes', 'people who have diabetes'),
  condition('high_blood_pressure', 'High blood pressure', 'people who have high blood pressure'),
  condition(
    'kidney',
    'Kidney disease',
    'people who have kidney disease or reduced kidney function',
  ),
  condition('liver', 'Liver disease', 'people who have liver disease'),
  condition('heart', 'Heart disease', 'people who have heart disease, including heart failure'),
  condition('asthma', 'Asthma', 'people who have asthma'),
  condition('glaucoma', 'Glaucoma', 'people who have glaucoma'),
  condition(
    'enlarged_prostate',
    'Enlarged prostate',
    'people who have an enlarged prostate or trouble urinating',
  ),
  condition(
    'stomach_ulcers',
    'Stomach ulcers or bleeding',
    'people who have stomach ulcers or stomach bleeding',
  ),
  question({
    id: 'alcohol',
    subject: 'drinking alcohol while using this drug',
    group: 'combinations',
    title: 'Alcohol',
    otcSections: ['warnings', 'when_using'],
    prescriptionSections: ['warnings_and_cautions', 'warnings', 'precautions', 'drug_interactions'],
  }),
  question({
    id: 'blood_thinners',
    subject: 'using this drug together with blood thinners (anticoagulants such as warfarin)',
    group: 'combinations',
    title: 'Blood thinners',
    otcSections: ['ask_doctor_or_pharmacist'],
    prescriptionSections: ['drug_interactions'],
  }),
  question({
    id: 'drowsiness_driving',
    subject: 'drowsiness, or driving and operating machinery, while using this drug',
    group: 'daily_life',
    title: 'Drowsiness and driving',
    otcSections: ['when_using'],
    prescriptionSections: [
      'warnings_and_cautions',
      'warnings',
      'precautions',
      'information_for_patients',
    ],
  }),
  question({
    id: 'take_with_food',
    subject: 'taking this drug with or without food',
    group: 'daily_life',
    title: 'Taking with food',
    otcSections: ['dosage_and_administration'],
    prescriptionSections: ['dosage_and_administration'],
  }),
  question({
    id: 'boxed_warning',
    subject: 'serious risks highlighted in a boxed warning',
    group: 'serious',
    title: 'Boxed warning',
    otcSections: [],
    prescriptionSections: ['boxed_warning'],
  }),
  question({
    id: 'allergy',
    subject: 'people who have had an allergic reaction to this drug or its ingredients',
    group: 'serious',
    title: 'Allergy warnings',
    otcSections: ['do_not_use', 'warnings'],
    prescriptionSections: ['contraindications'],
  }),
]

const BY_ID = new Map<string, Question>(CATALOG.map((q) => [q.id, q]))

export function getQuestion(questionId: string): Question {
  const found = BY_ID.get(questionId)
  if (found === undefined) throw new Error(`Unknown question: ${questionId}`)
  return found
}

function hasText(label: Label, section: string): boolean {
  return !isBlank(label.sections[section] ?? '')
}

export function labelFormat(label: Label): Layout {
  return OTC_MARKERS.some((marker) => hasText(label, marker)) ? 'otc' : 'prescription'
}

export function candidateSections(questionId: string, label: Label): string[] {
  const q = getQuestion(questionId)
  const wanted = labelFormat(label) === 'otc' ? q.otcSections : q.prescriptionSections
  return wanted.filter((name) => hasText(label, name))
}

/**
 * Sections a reader's own question may be answered from: every section the catalog reads
 * for this label, in catalog order.
 */
export function customSections(label: Label): string[] {
  return [...new Set(CATALOG.flatMap((q) => candidateSections(q.id, label)))]
}
