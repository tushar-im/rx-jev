import { describe, expect, it } from 'vitest'
import { CATALOG, candidateSections, getQuestion, labelFormat } from '../src/catalog.ts'
import { recordedOpenFda } from './helpers.ts'
import { labelWith } from './labels.ts'

async function canonical(drug: string[]) {
  return recordedOpenFda().canonicalLabels(drug)
}

describe('catalog', () => {
  it('has 19 unique, grouped, titled questions', () => {
    const ids = CATALOG.map((q) => q.id)

    expect(ids).toHaveLength(19)
    expect(new Set(ids).size).toBe(19)
    expect(new Set(CATALOG.map((q) => q.group))).toEqual(
      new Set(['who', 'conditions', 'combinations', 'daily_life', 'serious']),
    )
    expect(CATALOG.every((q) => q.title.trim())).toBe(true)
  })

  it('throws for an unknown question', () => {
    expect(() => getQuestion('is_it_safe')).toThrow()
  })

  it('reads OTC sections on an OTC label', async () => {
    const label = (await canonical(['ibuprofen'])).otc
    if (!label) throw new Error('No label')

    expect(labelFormat(label)).toBe('otc')
    expect(candidateSections('pregnancy', label)).toEqual(['pregnancy_or_breast_feeding'])
    expect(candidateSections('kidney', label)).toEqual(['do_not_use', 'ask_doctor', 'warnings'])
    expect(candidateSections('blood_thinners', label)).toEqual(['ask_doctor_or_pharmacist'])
  })

  it('reads PLR sections on a modern prescription label', async () => {
    const label = (await canonical(['metformin'])).prescription
    if (!label) throw new Error('No label')

    expect(labelFormat(label)).toBe('prescription')
    expect(candidateSections('pregnancy', label)).toEqual([
      'pregnancy',
      'use_in_specific_populations',
    ])
    expect(candidateSections('kidney', label)).toEqual([
      'contraindications',
      'warnings_and_cautions',
      'use_in_specific_populations',
    ])
    expect(candidateSections('boxed_warning', label)).toEqual(['boxed_warning'])
  })

  it('falls back to warnings and precautions on an older prescription label', async () => {
    const label = (await canonical(['ibuprofen'])).prescription
    if (!label) throw new Error('No label')

    expect(candidateSections('kidney', label)).toEqual([
      'contraindications',
      'warnings',
      'precautions',
    ])
    expect(candidateSections('alcohol', label)).toEqual([
      'warnings',
      'precautions',
      'drug_interactions',
    ])
  })

  it('reads a prescription label with OTC sections as OTC', async () => {
    const label = (await canonical(['loratadine'])).prescription
    if (!label) throw new Error('No label')

    expect(label.product_type).toBe('prescription')
    expect(labelFormat(label)).toBe('otc')
    expect(candidateSections('pregnancy', label)).toEqual(['pregnancy_or_breast_feeding'])
  })

  it('has no boxed warning candidates on OTC labels', () => {
    const label = labelWith({ do_not_use: 'Do not use if allergic.', boxed_warning: 'Odd.' })

    expect(candidateSections('boxed_warning', label)).toEqual([])
  })

  it('never offers blank sections', () => {
    const label = labelWith({ do_not_use: '   ', ask_doctor: 'Ask a doctor if you have asthma.' })

    expect(candidateSections('asthma', label)).toEqual(['ask_doctor'])
  })

  it('orders sections as the catalog does, not the label', () => {
    const label = labelWith({ warnings: 'W.', ask_doctor: 'A.', do_not_use: 'D.' })

    expect(candidateSections('diabetes', label)).toEqual(['do_not_use', 'ask_doctor', 'warnings'])
  })

  it('does not read a blank OTC marker as an OTC label', () => {
    const label = labelWith(
      { do_not_use: '  ', boxed_warning: 'WARNING: LACTIC ACIDOSIS.' },
      'prescription',
    )

    expect(labelFormat(label)).toBe('prescription')
    expect(candidateSections('boxed_warning', label)).toEqual(['boxed_warning'])
  })
})
