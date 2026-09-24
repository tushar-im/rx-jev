import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnswersResponse, ResolvedDrug } from './api.ts'
import { DrugAnswers } from './DrugAnswers.tsx'
import { answer, askResponse, labelAnswers, sourceTrace } from './testing.ts'

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
  sources: sourceTrace(),
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

  it('clears a custom answer when the label changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const body = String(input).endsWith('/ask') ? askResponse() : both
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    render(<DrugAnswers drug={ibuprofen} />)
    fireEvent.change(await screen.findByRole('textbox', { name: /your own question/i }), {
      target: { value: 'Can I take it with grapefruit juice?' },
    })
    fireEvent.submit(screen.getByRole('form', { name: /your own question/i }))
    await screen.findByRole('heading', { name: 'What the label says about your question' })

    fireEvent.click(screen.getByRole('button', { name: 'Prescription' }))

    expect(
      screen.queryByRole('heading', { name: 'What the label says about your question' }),
    ).not.toBeInTheDocument()
  })

  it('reports the Jev usage of a response once, even when an aborted request still answers', async () => {
    // StrictMode runs the fetch effect twice; this fetch ignores the first one's abort.
    mockAnswers(200, both)
    const onUsage = vi.fn()
    render(
      <StrictMode>
        <DrugAnswers drug={ibuprofen} onUsage={onUsage} />
      </StrictMode>,
    )
    await screen.findByRole('button', { name: 'Pregnancy' })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await waitFor(() => expect(onUsage).toHaveBeenCalledOnce())
    expect(onUsage).toHaveBeenCalledWith({ tokens: 0, live: 0, stored: 2 })
  })

  it("names the switch as a choice of label and counts each label's clear answers", async () => {
    const unclear = (id: string) => answer(id, { confident: false })
    const mixed: AnswersResponse = {
      ...both,
      labels: [
        {
          ...otc,
          answers: otc.answers.map((a) => (a.question_id === 'kidney' ? unclear('kidney') : a)),
        },
        {
          ...prescription,
          answers: prescription.answers.map((a) =>
            a.question_id === 'pregnancy' ? a : unclear(a.question_id),
          ),
        },
      ],
    }
    mockAnswers(200, mixed)
    render(<DrugAnswers drug={ibuprofen} />)

    const group = await screen.findByRole('group', { name: 'Which label' })
    expect(group).toHaveTextContent('Over-the-counter10 clear')
    expect(screen.getByRole('button', { name: 'Over-the-counter' })).toHaveAccessibleDescription(
      '10 questions with a clear answer',
    )
    expect(screen.getByRole('button', { name: 'Prescription' })).toHaveAccessibleDescription(
      '1 question with a clear answer',
    )
  })

  it('points to the other label when only it answers the question clearly', async () => {
    const mixed: AnswersResponse = {
      ...both,
      labels: [
        {
          ...otc,
          answers: otc.answers.map((a) =>
            a.question_id === 'pregnancy' ? answer('pregnancy', { confident: false }) : a,
          ),
        },
        prescription,
      ],
    }
    mockAnswers(200, mixed)
    render(<DrugAnswers drug={ibuprofen} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pregnancy' }))

    expect(screen.getByText(/couldn't find a clear answer/)).toBeInTheDocument()
    expect(screen.getByText('The prescription label answers this.')).toBeInTheDocument()
    // The pointer says an answer exists, never what it is.
    expect(screen.queryByText(/Avoid use of NSAIDs/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show the prescription label' }))

    expect(screen.getByRole('button', { name: 'Prescription' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('blockquote')).toHaveTextContent(/Avoid use of NSAIDs/)
  })

  it('points only from an unclear answer to a clear one on the other label', async () => {
    const mixed: AnswersResponse = {
      ...both,
      labels: [
        otc,
        {
          ...prescription,
          answers: prescription.answers.map((a) =>
            a.question_id === 'kidney' ? answer('kidney', { confident: false }) : a,
          ),
        },
      ],
    }
    mockAnswers(200, mixed)
    render(<DrugAnswers drug={ibuprofen} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pregnancy' }))
    expect(screen.queryByText(/label answers this/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Prescription' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kidney disease' }))
    // Over-the-counter answers kidney clearly, so the prescription card points back to it.
    expect(screen.getByText('The over-the-counter label answers this.')).toBeInTheDocument()
  })
})
