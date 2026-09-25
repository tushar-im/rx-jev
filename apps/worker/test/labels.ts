import type { ProductType } from '@rx-jev/contract'
import type { Label } from '../src/clients/openfda.ts'
import { MAX_CHOICE_OPTIONS } from '../src/judge.ts'
import { recordedOpenFda } from './helpers.ts'

// Labels for tests: canonical labels from the recorded openFDA fixtures, and made-up ones.

export async function metforminRx(): Promise<Label> {
  const label = (await recordedOpenFda().canonicalLabels(['metformin'])).prescription
  if (label === null) throw new Error('No recorded metformin label')
  return label
}

export async function ibuprofenOtc(): Promise<Label> {
  const label = (await recordedOpenFda().canonicalLabels(['ibuprofen'])).otc
  if (label === null) throw new Error('No recorded ibuprofen label')
  return label
}

export function labelWith(
  sections: Record<string, string>,
  productType: ProductType = 'otc',
): Label {
  return {
    set_id: 's',
    version: '1',
    effective_time: '2026-01-01',
    product_type: productType,
    brand_name: null,
    manufacturer_name: null,
    substance_names: ['X'],
    is_original_packager: true,
    sections,
  }
}

export function longText(sentences: number): string {
  return Array.from({ length: sentences }, (_, n) => `Sentence number ${n} is here.`).join(' ')
}

/** More evidence candidates than one Choice holds when `sentences` is MAX_CHOICE_OPTIONS. */
export function longLabel(sentences: number = MAX_CHOICE_OPTIONS): Label {
  return labelWith(
    { pregnancy: 'Pregnancy is discussed here.', contraindications: longText(sentences) },
    'prescription',
  )
}

/** A real label layout, but none of the sections any catalog question reads. */
export function unanswerableLabel(): Label {
  return { ...longLabel(0), sections: { indications_and_usage: 'Used to treat X in adults.' } }
}
