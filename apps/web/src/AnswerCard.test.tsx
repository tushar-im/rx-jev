import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AnswerCard } from './AnswerCard.tsx'
import { answer, labelAnswers } from './testing.ts'

const label = labelAnswers()

describe('AnswerCard', () => {
  it('asks what the label says, never whether it is safe', () => {
    render(<AnswerCard label={label} answer={answer('pregnancy')} />)

    expect(
      screen.getByRole('heading', { name: 'What the label says about pregnancy' }),
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\bsafe\b|allowed|ok to take/i)
  })

  it('shows the category and the quoted sentence with its lead-in, verbatim', () => {
    render(<AnswerCard label={label} answer={answer('pregnancy')} />)

    expect(screen.getByText('The label advises caution')).toBeInTheDocument()
    const quote = screen.getByRole('blockquote')
    expect(quote).toHaveTextContent('If pregnant or breast-feeding, ask a health professional before use.')
    expect(screen.getByText('From the label section: Pregnancy or breast feeding')).toBeInTheDocument()
  })

  it.each([
    ['warns_against', 'The label warns against use'],
    ['caution', 'The label advises caution'],
    ['dose_change', 'The label gives a different dose'],
    ['no_known_issue', 'The label says no problem is known'],
    ['not_mentioned', 'The label does not mention this'],
  ] as const)('names the %s category in label terms', (choice, text) => {
    const base = answer('kidney')
    const stance = base.stance && { ...base.stance, choice }
    render(<AnswerCard label={label} answer={{ ...base, stance }} />)

    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('carries the label version, date and a DailyMed link', () => {
    render(<AnswerCard label={label} answer={answer('pregnancy')} />)

    expect(screen.getByText(/Advil label, version 5, effective September 9, 2026/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Read the full label on DailyMed' })).toHaveAttribute(
      'href',
      label.dailymed_url,
    )
  })

  it('always points to a pharmacist and says when no pharmacist has checked it', () => {
    render(<AnswerCard label={label} answer={answer('pregnancy', { reviewed: false })} />)

    expect(screen.getByText(/Ask your pharmacist/)).toBeInTheDocument()
    expect(screen.getByText('Not yet checked by a pharmacist.')).toBeInTheDocument()
  })

  it('shows no category or quote when the answer is not confident', () => {
    render(<AnswerCard label={label} answer={answer('pregnancy', { confident: false })} />)

    expect(
      screen.getByText("We couldn't find a clear answer. Read the full label or ask a pharmacist."),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^The label /)).not.toBeInTheDocument()
    expect(screen.queryByRole('blockquote')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Read the full label on DailyMed' })).toBeInTheDocument()
  })

  it('says the label has no section for a question it cannot answer', () => {
    const skipped = answer('boxed_warning', {
      status: 'no_sections',
      confident: false,
      stance: null,
      evidence: null,
    })
    render(<AnswerCard label={label} answer={skipped} />)

    expect(
      screen.getByText(
        'This label has no section about this. Read the full label or ask a pharmacist.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/couldn't find a clear answer/)).not.toBeInTheDocument()
  })

  it('treats a question too long to judge as having no clear answer', () => {
    const skipped = answer('kidney', {
      status: 'too_long',
      confident: false,
      stance: null,
      evidence: null,
    })
    render(<AnswerCard label={label} answer={skipped} />)

    expect(
      screen.getByText("We couldn't find a clear answer. Read the full label or ask a pharmacist."),
    ).toBeInTheDocument()
  })

  it('shows no category when evidence is none, even if the API says confident', () => {
    const base = answer('pregnancy')
    const evidence = base.evidence && { ...base.evidence, choice: 'none', quote: null }
    render(<AnswerCard label={label} answer={{ ...base, evidence }} />)

    expect(screen.queryByText(/^The label /)).not.toBeInTheDocument()
    expect(screen.getByText(/couldn't find a clear answer/)).toBeInTheDocument()
  })
})
