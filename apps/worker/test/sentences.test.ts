import { beforeAll, describe, expect, it } from 'vitest'
import type { CanonicalLabels, Label } from '../src/clients/openfda.ts'
import { labelCandidates, splitSection } from '../src/sentences.ts'
import { recordedOpenFda } from './helpers.ts'

function texts(section: string, text: string): string[] {
  return splitSection(section, text).map((c) => c.text)
}

function leadIns(section: string, text: string): [string, string | null][] {
  return splitSection(section, text).map((c) => [c.text, c.lead_in?.text ?? null])
}

let recorded: CanonicalLabels[] = []

beforeAll(async () => {
  const client = recordedOpenFda()
  const drugs = [['ibuprofen'], ['metformin'], ['acetaminophen', 'diphenhydramine'], ['loratadine']]
  recorded = await Promise.all(drugs.map((d) => client.canonicalLabels(d)))
})

function recordedLabels(): Label[] {
  return recorded.flatMap((c) => [c.otc, c.prescription]).filter((l): l is Label => l !== null)
}

describe('splitSection', () => {
  it('splits on sentence ends', () => {
    expect(texts('w', 'Stop use if rash occurs. Ask a doctor! Is it red? Yes.')).toEqual([
      'Stop use if rash occurs.',
      'Ask a doctor!',
      'Is it red?',
      'Yes.',
    ])
  })

  it('splits on bullets', () => {
    expect(
      texts('d', 'Directions ■ do not take more ■ adults: • take 1 tablet ▪ children: ask'),
    ).toEqual(['Directions', 'do not take more', 'adults:', 'take 1 tablet', 'children: ask'])
  })

  it('does not split decimals, lowercase continuations or abbreviations', () => {
    const text =
      'Avoid if eGFR is below 1.73 mL/min. Other NSAIDs, e.g. Aspirin, may add risk. ' +
      'Take 2.5 mg. daily with food. Dr. Smith is not a real reference.'

    expect(texts('w', text)).toEqual([
      'Avoid if eGFR is below 1.73 mL/min.',
      'Other NSAIDs, e.g. Aspirin, may add risk.',
      'Take 2.5 mg. daily with food.',
      'Dr. Smith is not a real reference.',
    ])
  })

  it('drops pieces without letters', () => {
    expect(texts('c', '• • Hypersensitivity to metformin. ( 4 ) • 12.')).toEqual([
      'Hypersensitivity to metformin. ( 4 )',
    ])
  })

  it('finds no candidates in a blank section', () => {
    expect(splitSection('w', '  \n ')).toEqual([])
  })

  it('numbers ids within the section', () => {
    const candidates = splitSection('pregnancy', 'One. Two. Three.')

    expect(candidates.map((c) => c.id)).toEqual(['pregnancy:1', 'pregnancy:2', 'pregnancy:3'])
    expect(candidates.every((c) => c.section === 'pregnancy')).toBe(true)
  })

  it('follows the requested section order', () => {
    const label = recorded[0]?.otc
    if (!label) throw new Error('No ibuprofen OTC label')
    const order = ['ask_doctor', 'do_not_use']

    const sections = labelCandidates(label, order).map((c) => c.section)

    expect(sections).toEqual([...sections].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    expect(new Set(sections)).toEqual(new Set(order))
  })

  it('keeps an unbulleted OTC block as one candidate', () => {
    const text = recorded[0]?.otc?.sections.do_not_use ?? ''

    expect(texts('do_not_use', text)).toEqual([text.trim()])
  })

  it('splits prescription bullets into separate candidates', () => {
    const text = recorded[1]?.prescription?.sections.contraindications ?? ''

    expect(texts('contraindications', text)).toContain('Hypersensitivity to metformin.')
  })

  it('takes every candidate verbatim from real label text', () => {
    let checked = 0
    for (const label of recordedLabels()) {
      for (const [section, text] of Object.entries(label.sections)) {
        for (const c of splitSection(section, text)) {
          expect(c.text).toBe(text.slice(c.start, c.end))
          expect(c.text).toBe(c.text.trim())
          expect(c.text).not.toBe('')
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  it('gives bullets their governing lead-in', () => {
    const text =
      'Metformin is contraindicated in patients with: • Severe renal impairment. ' +
      '• Hypersensitivity to metformin.'

    expect(leadIns('contraindications', text)).toEqual([
      ['Metformin is contraindicated in patients with:', null],
      ['Severe renal impairment.', 'Metformin is contraindicated in patients with:'],
      ['Hypersensitivity to metformin.', 'Metformin is contraindicated in patients with:'],
    ])
  })

  it('treats an OTC heading without a colon as a lead-in', () => {
    expect(
      leadIns('stop_use', 'Stop use and ask a doctor if • you feel faint • pain gets worse'),
    ).toEqual([
      ['Stop use and ask a doctor if', null],
      ['you feel faint', 'Stop use and ask a doctor if'],
      ['pain gets worse', 'Stop use and ask a doctor if'],
    ])
  })

  it('uses the inner lead-in in a nested list and the outer one for self-contained items', () => {
    const text =
      'Directions ■ do not take more than directed ■ adults and children 12 years and older: ' +
      '■ take 1 tablet every 4 to 6 hours ■ do not exceed 6 tablets in 24 hours ' +
      '■ children under 12 years: ask a doctor'

    expect(leadIns('dosage_and_administration', text)).toEqual([
      ['Directions', null],
      ['do not take more than directed', 'Directions'],
      ['adults and children 12 years and older:', 'Directions'],
      ['take 1 tablet every 4 to 6 hours', 'adults and children 12 years and older:'],
      ['do not exceed 6 tablets in 24 hours', 'adults and children 12 years and older:'],
      ['children under 12 years: ask a doctor', 'Directions'],
    ])
  })

  it('gives a new list after prose a new lead-in', () => {
    const text =
      'Intro: • Geriatric Use: Assess renal function. Other prose here. ' +
      'Use caution in patients with: • heart failure • sepsis'

    expect(leadIns('w', text).slice(-2)).toEqual([
      ['heart failure', 'Use caution in patients with:'],
      ['sepsis', 'Use caution in patients with:'],
    ])
  })

  it('gives prose and later sentences in an item no lead-in', () => {
    expect(leadIns('w', 'Intro: • First item. Trailing prose.')).toEqual([
      ['Intro:', null],
      ['First item.', 'Intro:'],
      ['Trailing prose.', null],
    ])
  })

  it('takes every lead-in verbatim from before its item', () => {
    let checked = 0
    for (const label of recordedLabels()) {
      for (const [section, text] of Object.entries(label.sections)) {
        for (const c of splitSection(section, text)) {
          if (c.lead_in === null) continue
          expect(c.lead_in.text).toBe(text.slice(c.lead_in.start, c.lead_in.end))
          expect(c.lead_in.end).toBeLessThanOrEqual(c.start)
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('does not split company or country abbreviations', () => {
    const text =
      'Made by Acme Pvt. Ltd. Sangareddy, India. Report to the U.S. Food and Drug Administration.'

    expect(texts('w', text)).toEqual([
      'Made by Acme Pvt. Ltd. Sangareddy, India.',
      'Report to the U.S. Food and Drug Administration.',
    ])
  })

  it('treats whitespace exactly as Python does', () => {
    // Python counts \x1c to \x1f and \x85 as whitespace but not U+FEFF; JavaScript's \s is
    // the other way round. Label text must split the same in both.
    expect(texts('w', 'One.\x85Two.')).toEqual(['One.', 'Two.'])
    expect(texts('w', 'One.\x1fTwo.')).toEqual(['One.', 'Two.'])
    const bom = String.fromCharCode(0xfeff)
    expect(texts('w', `One.${bom}Two.`)).toEqual([`One.${bom}Two.`])
    expect(texts('w', '\x1c Padded. \x85')).toEqual(['Padded.'])
  })
})
