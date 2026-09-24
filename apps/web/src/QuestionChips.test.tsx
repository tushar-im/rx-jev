import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QuestionChips } from './QuestionChips.tsx'
import { labelAnswers } from './testing.ts'

describe('QuestionChips', () => {
  const { answers } = labelAnswers()

  it('groups the questions as the catalog does, in catalog order', () => {
    render(<QuestionChips answers={answers} selected={null} onSelect={vi.fn()} />)

    const groups = screen.getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Who is taking it',
      'Health conditions',
      'Taken with',
      'Daily life',
      'Serious warnings',
    ])
    const who = within(groups[0] as HTMLElement).getAllByRole('button')
    expect(who.map((b) => b.textContent)).toEqual([
      'Pregnancy',
      'Breastfeeding',
      'Children',
      'Older adults',
    ])
  })

  it('hides taking with food until it has its own answer options', () => {
    render(<QuestionChips answers={answers} selected={null} onSelect={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Taking with food' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Drowsiness and driving' })).toBeInTheDocument()
  })

  it('marks the selected question and reports clicks', () => {
    const onSelect = vi.fn()
    render(<QuestionChips answers={answers} selected="alcohol" onSelect={onSelect} />)

    expect(screen.getByRole('button', { name: 'Alcohol' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Pregnancy' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pregnancy' }))
    expect(onSelect).toHaveBeenCalledWith('pregnancy')
  })

  it('leaves out a group with no visible questions', () => {
    const onlyFood = answers.filter((a) => a.question_id === 'take_with_food')
    render(<QuestionChips answers={onlyFood} selected={null} onSelect={vi.fn()} />)

    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })
})
