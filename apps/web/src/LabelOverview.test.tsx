import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { STANCES } from './api.ts'
import { LabelOverview } from './LabelOverview.tsx'
import { answer, labelAnswers, labelOverview } from './testing.ts'

const BOXED = `WARNING: SUICIDAL THOUGHTS AND BEHAVIORS ${'Antidepressants increased the risk. '.repeat(40)}`

function rxLabel() {
  return labelAnswers({
    product_type: 'prescription',
    layout: 'prescription',
    overview: {
      boxed_warning: { section: 'boxed_warning', text: BOXED },
      purpose: null,
      uses: {
        section: 'indications_and_usage',
        text: '1 INDICATIONS AND USAGE Bupropion hydrochloride tablets are indicated for MDD.',
      },
      strengths: {
        section: 'dosage_forms_and_strengths',
        text: '3 DOSAGE FORMS AND STRENGTHS 75 mg – orange, round tablets.',
      },
    },
  })
}

describe('LabelOverview', () => {
  it('shows the boxed warning first, whole and verbatim', () => {
    render(<LabelOverview label={rxLabel()} onPick={vi.fn()} />)

    const boxed = screen.getByRole('note', { name: 'Boxed warning' })
    expect(boxed).toHaveTextContent(BOXED.trim())
  })

  it('collapses a long section but keeps all of it on the page', () => {
    render(<LabelOverview label={rxLabel()} onPick={vi.fn()} />)
    const boxed = screen.getByRole('note', { name: 'Boxed warning' })
    const toggle = within(boxed).getByRole('button', { name: 'Show all' })

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(boxed).toHaveTextContent(BOXED.trim())
    fireEvent.click(toggle)
    expect(within(boxed).getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('starts every section of another label collapsed', () => {
    const longUses = (setId: string) =>
      labelAnswers({
        set_id: setId,
        overview: {
          ...labelOverview(),
          uses: { section: 'indications_and_usage', text: `${setId} ${'Uses. '.repeat(150)}` },
        },
      })
    const { rerender } = render(<LabelOverview label={longUses('otc-set')} onPick={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()

    // The other label has the same section in the same place.
    rerender(<LabelOverview label={longUses('rx-set')} onPick={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Show all' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull()
  })

  it('renders section text exactly as the label has it', () => {
    const text = '  Purpose\nPain reliever  '
    const label = labelAnswers({
      overview: { ...labelOverview(), purpose: { section: 'purpose', text } },
    })
    render(<LabelOverview label={label} onPick={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Purpose' }).nextElementSibling?.textContent).toBe(
      text,
    )
  })

  it('shows the grid alone when the API sends no overview', () => {
    const { overview: _overview, ...label } = labelAnswers()
    render(<LabelOverview label={label} onPick={vi.fn()} />)

    expect(screen.getByRole('region', { name: 'At a glance' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Purpose' })).toBeNull()
  })

  it('quotes the uses and strengths under their section names', () => {
    render(<LabelOverview label={rxLabel()} onPick={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Indications and usage' })).toBeInTheDocument()
    expect(screen.getByText(/indicated for MDD\./)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Dosage forms and strengths' })).toBeInTheDocument()
    expect(screen.getByText(/75 mg – orange, round tablets\./)).toBeInTheDocument()
    // Only the long boxed warning is collapsed.
    expect(screen.getAllByRole('button', { name: 'Show all' })).toHaveLength(1)
  })

  it('shows an OTC label its purpose and active ingredient, and no boxed warning', () => {
    render(<LabelOverview label={labelAnswers()} onPick={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Purpose' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Active ingredient' })).toBeInTheDocument()
    expect(screen.queryByRole('note', { name: 'Boxed warning' })).toBeNull()
  })

  it('says which questions have a clear answer, and opens one when picked', () => {
    const onPick = vi.fn()
    const label = labelAnswers({
      answers: [answer('pregnancy'), answer('kidney', { confident: false })],
    })
    render(<LabelOverview label={label} onPick={onPick} />)

    const glance = screen.getByRole('region', { name: 'At a glance' })
    const pregnancy = within(glance).getByRole('button', { name: /pregnancy/i })
    expect(pregnancy).toHaveTextContent('Clear answer')
    expect(within(glance).getByRole('button', { name: /kidney/i })).toHaveTextContent(
      'No clear answer',
    )
    fireEvent.click(pregnancy)
    expect(onPick).toHaveBeenCalledWith('pregnancy')
  })

  it('points to the boxed warning shown above rather than calling it unclear', () => {
    const label = rxLabel()
    render(
      <LabelOverview
        label={{ ...label, answers: [answer('boxed_warning', { confident: false })] }}
        onPick={vi.fn()}
      />,
    )

    const glance = screen.getByRole('region', { name: 'At a glance' })
    expect(within(glance).getByRole('button', { name: /boxed warning/i })).toHaveTextContent(
      'Shown above',
    )
  })

  it('never shows what an answer says, only on its card', () => {
    render(<LabelOverview label={labelAnswers()} onPick={vi.fn()} />)

    const glance = screen.getByRole('region', { name: 'At a glance' })
    const text = (glance.textContent ?? '').toLowerCase()
    for (const stance of [...STANCES, ...STANCES.map((s) => s.replaceAll('_', ' '))]) {
      expect(text).not.toContain(stance)
    }
    expect(text).not.toMatch(/warns|advises|different dose|no problem|%/)
  })

  it('names the label and links to it on DailyMed', () => {
    render(<LabelOverview label={labelAnswers()} onPick={vi.fn()} />)

    expect(screen.getByText(/version 5/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /read the full label on dailymed/i })).toHaveAttribute(
      'href',
      labelAnswers().dailymed_url,
    )
  })
})
