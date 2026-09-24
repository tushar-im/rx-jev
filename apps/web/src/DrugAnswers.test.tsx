import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnswersResponse, ResolvedDrug } from './api.ts'
import { DrugAnswers } from './DrugAnswers.tsx'
import { answer, labelAnswers } from './testing.ts'

const ibuprofen: ResolvedDrug = {
  query: 'advil',
  rxcui: '5640',
  ingredients: [{ rxcui: '5640', name: 'ibuprofen' }],
}

const otc = labelAnswers()
const prescription = labelAnswers({
  set_id: 'rx-set',
  version: '12',
  product_type: 'prescription',
  brand_name: null,
  dailymed_url: 'https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=rx-set',
  answers: labelAnswers().answers.map((a) =>
    a.question_id === 'pregnancy'
      ? answer('pregnancy', {
          evidence: {
            choice: 's40',
            confidence: 0.97,
            probability: 0.97,
            quote: {
              section: 'pregnancy',
              text: 'Avoid use of NSAIDs in pregnant women at about 30 weeks gestation and later.',
              lead_in: null,
            },
          },
        })
      : a,
  ),
})

function mockAnswers(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const both: AnswersResponse = {
  rxcui: '5640',
  ingredients: ibuprofen.ingredients,
  labels: [otc, prescription],
}

describe('DrugAnswers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the answers for the resolved RxCUI', async () => {
    const fetchMock = mockAnswers(200, both)
    render(<DrugAnswers drug={ibuprofen} />)

    expect(await screen.findByRole('button', { name: 'Pregnancy' })).toBeInTheDocument()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/labels/5640/answers')
  })

  it('shows the answer card for the chosen question', async () => {
    mockAnswers(200, both)
    render(<DrugAnswers drug={ibuprofen} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pregnancy' }))

    expect(
      screen.getByRole('heading', { name: 'What the label says about pregnancy' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('blockquote')).toHaveTextContent(
      'ask a health professional before use.',
    )
  })

  it('switches between the OTC and prescription labels, keeping the question', async () => {
    mockAnswers(200, both)
    render(<DrugAnswers drug={ibuprofen} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pregnancy' }))

    expect(screen.getByRole('button', { name: 'Over-the-counter' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Prescription' }))

    expect(screen.getByRole('blockquote')).toHaveTextContent(
      'Avoid use of NSAIDs in pregnant women at about 30 weeks gestation and later.',
    )
    expect(screen.getByText(/Prescription label, version 12/)).toBeInTheDocument()
  })

  it('offers no switch when there is only one label', async () => {
    mockAnswers(200, { ...both, labels: [prescription] })
    render(<DrugAnswers drug={ibuprofen} />)
    await screen.findByRole('button', { name: 'Pregnancy' })

    expect(screen.queryByRole('button', { name: 'Over-the-counter' })).not.toBeInTheDocument()
  })

  it('says it is reading the label while answers load', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    render(<DrugAnswers drug={ibuprofen} />)

    expect(screen.getByRole('status')).toHaveTextContent(/Reading the label/)
  })

  it('passes on why no label was found', async () => {
    mockAnswers(404, {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No FDA label found for ibuprofen.',
    })
    render(<DrugAnswers drug={ibuprofen} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('No FDA label found for ibuprofen.')
  })

  it.each([502, 503])('shows a plain message when the service fails with %i', async (status) => {
    mockAnswers(status, {
      type: 'about:blank',
      title: 'Service Unavailable',
      status,
      detail: 'internal detail',
    })
    render(<DrugAnswers drug={ibuprofen} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Answers are unavailable right now. Try again later.')
    expect(alert).not.toHaveTextContent('internal detail')
  })
})
