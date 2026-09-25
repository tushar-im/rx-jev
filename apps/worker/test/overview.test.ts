import { describe, expect, it } from 'vitest'
import { labelOverview } from '../src/views.ts'
import { labelWith } from './labels.ts'

// An OTC label (it has a Drug Facts section) with the given sections.
function otc(sections: Record<string, string>) {
  return labelOverview(labelWith({ do_not_use: 'Do not use if allergic.', ...sections }))
}

function rx(sections: Record<string, string>) {
  return labelOverview(labelWith(sections, 'prescription'))
}

describe('overview headings', () => {
  it.each([
    ['purpose', 'Purposes Pain reliever/fever reducer', 'Purposes', 'Pain reliever/fever reducer'],
    ['purpose', 'PURPOSE Antihistamine', 'PURPOSE', 'Antihistamine'],
    [
      'indications_and_usage',
      'Uses temporarily relieves minor aches',
      'Uses',
      'temporarily relieves minor aches',
    ],
    ['indications_and_usage', 'USE(S) helps loosen phlegm', 'USE(S)', 'helps loosen phlegm'],
    [
      'indications_and_usage',
      'INDICATIONS: For the temporary relief',
      'INDICATIONS',
      'For the temporary relief',
    ],
    [
      'active_ingredient',
      'Active ingredient (in each capsule) Naproxen sodium 220 mg',
      'Active ingredient (in each capsule)',
      'Naproxen sodium 220 mg',
    ],
    [
      'active_ingredient',
      'ACTIVE INGREDIENT(S) Loratadine 10 mg',
      'ACTIVE INGREDIENT(S)',
      'Loratadine 10 mg',
    ],
  ])('moves the heading of %s into the caption: %s', (section, text, heading, body) => {
    const overview = otc({ [section]: text })
    const part =
      section === 'active_ingredient'
        ? overview.strengths
        : section === 'purpose'
          ? overview.purpose
          : overview.uses

    expect(part).toEqual({ section, heading, text: body })
  })

  it('drops a heading the label prints twice', () => {
    expect(
      otc({ purpose: 'Purpose Purpose Upset stomach reliever / antidiarrheal' }).purpose,
    ).toEqual({
      section: 'purpose',
      heading: 'Purpose',
      text: 'Upset stomach reliever / antidiarrheal',
    })
    expect(
      otc({ active_ingredient: 'Active Ingredient Active Ingredient Bismuth 525 mg' }).strengths,
    ).toEqual({
      section: 'active_ingredient',
      heading: 'Active Ingredient',
      text: 'Bismuth 525 mg',
    })
  })

  it('reads numbered prescription headings', () => {
    const overview = rx({
      indications_and_usage: '1 INDICATIONS AND USAGE Metformin is indicated for adults.',
      dosage_forms_and_strengths: '3. DOSAGE FORMS & STRENGTHS Tablets: 500 mg.',
    })

    expect(overview.uses).toEqual({
      section: 'indications_and_usage',
      heading: '1 INDICATIONS AND USAGE',
      text: 'Metformin is indicated for adults.',
    })
    expect(overview.strengths).toEqual({
      section: 'dosage_forms_and_strengths',
      heading: '3. DOSAGE FORMS & STRENGTHS',
      text: 'Tablets: 500 mg.',
    })
  })

  it('keeps the full text when the section has no heading', () => {
    const text = '*Claims based on traditional homeopathic practice.'

    expect(otc({ purpose: text }).purpose).toEqual({ section: 'purpose', heading: null, text })
  })

  it('does not take the first word of a sentence for a heading', () => {
    const text = 'Use in children under 12 is not recommended.'

    expect(otc({ indications_and_usage: text }).uses).toEqual({
      section: 'indications_and_usage',
      heading: null,
      text,
    })
  })

  it('keeps the full text when the section is only a heading', () => {
    expect(otc({ purpose: 'Purpose' }).purpose).toEqual({
      section: 'purpose',
      heading: null,
      text: 'Purpose',
    })
  })

  it('never splits the boxed warning', () => {
    const text = 'WARNING: LACTIC ACIDOSIS Postmarketing cases have occurred.'

    expect(rx({ boxed_warning: text }).boxed_warning).toEqual({
      section: 'boxed_warning',
      heading: null,
      text,
    })
  })

  it('only ever moves heading words: the text is the rest of the section, verbatim', () => {
    const cases = [
      'Purpose Purpose Upset stomach reliever',
      'Purposes: Pain reliever',
      '  PURPOSE  Antihistamine',
    ]
    for (const original of cases) {
      const part = otc({ purpose: original }).purpose
      expect(part?.heading && original.includes(part.heading)).toBeTruthy()
      expect(original.endsWith(part?.text ?? '')).toBe(true)
      // Nothing but headings, spaces and separators is left out.
      const dropped = original.slice(0, original.length - (part?.text.length ?? 0))
      expect(dropped.replaceAll(part?.heading ?? '', '')).toMatch(/^[\s:.–-]*$/)
    }
  })
})
