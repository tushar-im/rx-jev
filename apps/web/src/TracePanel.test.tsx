import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HowItWorks, SessionTotals, TraceDetails } from './TracePanel.tsx'
import { STANCES } from './api.ts'
import { answer, askResponse, labelAnswers, sourceTrace } from './testing.ts'

describe('TraceDetails', () => {
  it('says how many labels openFDA matched for the label on screen', () => {
    render(<TraceDetails sources={sourceTrace()} label={labelAnswers()} focus={null} />)

    expect(screen.getByText(/831 original-packager over-the-counter labels/i)).toBeInTheDocument()
    expect(screen.getByText(/2 openFDA searches/i)).toBeInTheDocument()
  })

  it('says how many sentences Jev chose the quote from', () => {
    const focus = { kind: 'catalog' as const, answer: answer('pregnancy') }
    render(<TraceDetails sources={sourceTrace()} label={labelAnswers()} focus={focus} />)

    expect(screen.getByText(/picked 1 of 38 sentences/i)).toBeInTheDocument()
    expect(screen.getByText(/stance 95%, quote 93%/i)).toBeInTheDocument()
  })

  it('never shows the stance or a confidence for an answer that is not shown', () => {
    const focus = {
      kind: 'catalog' as const,
      answer: answer('pregnancy', { confident: false }),
    }
    render(<TraceDetails sources={sourceTrace()} label={labelAnswers()} focus={focus} />)

    expect(screen.getByText(/below the display threshold/i)).toBeInTheDocument()
    expect(screen.getByText(/jev read 38 sentences/i)).toBeInTheDocument()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/caution|%|picked/i)
    // No stance in any form, and no confidence as a percentage or a decimal.
    const section = screen.getByRole('heading', { name: 'This answer' }).parentElement
    const answerText = section?.textContent ?? ''
    for (const stance of [...STANCES, ...STANCES.map((s) => s.replaceAll('_', ' '))]) {
      expect(answerText.toLowerCase()).not.toContain(stance)
    }
    expect(answerText).not.toMatch(/\b[01]\.\d|%|warns|advises|different dose|no problem/i)
  })

  it('tells a stored run from a live one', () => {
    const { rerender } = render(
      <TraceDetails sources={sourceTrace()} label={labelAnswers()} focus={null} />,
    )
    expect(screen.getByText(/served from the store/i)).toBeInTheDocument()
    expect(screen.getByText(/11,024 tokens/)).toBeInTheDocument()

    rerender(
      <TraceDetails sources={sourceTrace()} label={labelAnswers({ fresh: true })} focus={null} />,
    )
    expect(screen.getByText(/judged just now/i)).toBeInTheDocument()
  })

  it('describes a custom question as asked live', () => {
    const focus = { kind: 'custom' as const, data: askResponse() }
    render(<TraceDetails sources={sourceTrace()} label={labelAnswers()} focus={focus} />)

    expect(screen.getByText(/asked live/i)).toBeInTheDocument()
    expect(screen.getByText(/2,161 tokens/)).toBeInTheDocument()
  })
})

describe('SessionTotals', () => {
  it('adds up the Jev tokens and calls of this session', () => {
    render(<SessionTotals session={{ tokens: 13185, live: 2, stored: 3 }} />)

    expect(screen.getByText('13,185')).toBeInTheDocument()
    expect(screen.getByText(/2 live Jev calls, 3 labels from the store/i)).toBeInTheDocument()
  })
})

describe('HowItWorks', () => {
  it('explains that Jev picks sentences and never writes them', () => {
    render(<HowItWorks />)

    expect(document.body.textContent).toMatch(/picks.*never writes/i)
  })

  it('does not call an unfiltered fallback total repackager labels', () => {
    const sources = sourceTrace({ matches: { otc: { total: 40, original_packager: false } } })
    render(<TraceDetails sources={sources} label={labelAnswers()} focus={null} />)

    expect(screen.getByText(/openFDA matched 40 over-the-counter labels/i)).toBeInTheDocument()
    expect(screen.getByText(/none from the original packager matched/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/repackager over-the-counter labels/i)
  })

  it("describes a custom question's own lookup, not the first one", () => {
    const data = askResponse()
    const focus = {
      kind: 'custom' as const,
      data: { ...data, sources: sourceTrace({ openfda_requests: 5 }) },
    }
    render(<TraceDetails sources={sourceTrace()} label={labelAnswers()} focus={focus} />)

    expect(screen.getByText(/5 openFDA searches/i)).toBeInTheDocument()
  })

  it('keeps a stored run visible when its token count is unknown', () => {
    const label = labelAnswers({ input_tokens: null, output_tokens: null })
    render(<TraceDetails sources={sourceTrace()} label={label} focus={null} />)

    expect(screen.getByText(/served from the store/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/tokens/)
  })
})
