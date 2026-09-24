import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomQuestion } from './CustomQuestion.tsx'
import { askResponse, labelAnswers } from './testing.ts'

const label = labelAnswers()
const GRAPEFRUIT = 'Can I take it with grapefruit juice?'

function mockAsk(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function askAbout(text: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: /your own question/i }), {
    target: { value: text },
  })
  fireEvent.submit(screen.getByRole('form', { name: /your own question/i }))
}

describe('CustomQuestion', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks about the label on screen and shows the answer card', async () => {
    const fetchMock = mockAsk(200, askResponse())
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout(GRAPEFRUIT)

    expect(
      await screen.findByRole('heading', { name: 'What the label says about your question' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('blockquote')).toHaveTextContent(
      'If pregnant or breast-feeding, ask a health professional before use.',
    )

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe('/api/labels/5640/ask')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ set_id: label.set_id, question: GRAPEFRUIT })
  })

  it('never shows a category it is not confident about', async () => {
    mockAsk(200, askResponse({ confident: false }))
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout(GRAPEFRUIT)

    expect(await screen.findByText(/couldn't find a clear answer/)).toBeInTheDocument()
    expect(screen.queryByRole('blockquote')).not.toBeInTheDocument()
  })

  it('says it is reading the label while Jev answers', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout(GRAPEFRUIT)

    expect(screen.getByRole('status')).toHaveTextContent(/Reading the label/)
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled()
  })

  it('does not send a blank question', () => {
    const fetchMock = mockAsk(200, askResponse())
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout('   ')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled()
  })

  it('shows a plain message when the service fails', async () => {
    mockAsk(503, {
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'internal detail',
    })
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout(GRAPEFRUIT)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Answers are unavailable right now. Try again later.')
    expect(alert).not.toHaveTextContent('internal detail')
  })

  it('shows only the answer to the latest question', async () => {
    const pending: ((r: Response) => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
    )
    const quoted = (text: string): Response =>
      new Response(
        JSON.stringify(
          askResponse({
            evidence: {
              choice: 's1',
              confidence: 0.95,
              probability: 0.95,
              quote: { section: 'warnings', text, lead_in: null },
            },
          }),
        ),
      )
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout('first question')
    askAbout('second question')

    pending[1]?.(quoted('Second answer.'))
    expect(await screen.findByRole('blockquote')).toHaveTextContent('Second answer.')
    pending[0]?.(quoted('First answer.'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    await waitFor(() => expect(screen.getByRole('blockquote')).toHaveTextContent('Second answer.'))
  })

  it('clears the answer once the question is edited', async () => {
    mockAsk(200, askResponse())
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout(GRAPEFRUIT)
    await screen.findByRole('blockquote')

    fireEvent.change(screen.getByRole('textbox', { name: /your own question/i }), {
      target: { value: 'Can I take it with milk?' },
    })

    expect(
      screen.queryByRole('heading', { name: 'What the label says about your question' }),
    ).not.toBeInTheDocument()
  })

  it('counts characters, not UTF-16 units, as the API does', () => {
    const fetchMock = mockAsk(200, askResponse())
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout('\u{1F600}\u{1F600}')

    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the question within the length the API accepts', () => {
    const fetchMock = mockAsk(200, askResponse())
    render(<CustomQuestion rxcui="5640" label={label} />)

    const input = screen.getByRole('textbox', { name: /your own question/i })
    fireEvent.change(input, { target: { value: 'x'.repeat(201) } })
    expect(input).toHaveValue('x'.repeat(200))

    // 200 emoji are 200 characters to the API, though 400 UTF-16 units.
    const emoji = '\u{1F600}'.repeat(200)
    fireEvent.change(input, { target: { value: emoji } })
    expect(input).toHaveValue(emoji)
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled()

    askAbout(' ab ')
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says when to try again after too many questions', async () => {
    mockAsk(429, {
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too many questions. Try again in 40 seconds.',
    })
    render(<CustomQuestion rxcui="5640" label={label} />)
    askAbout(GRAPEFRUIT)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many questions. Try again in 40 seconds.',
    )
  })
})
