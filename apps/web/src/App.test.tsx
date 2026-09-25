import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { askResponse, labelAnswers, sourceTrace } from './testing.ts'

// The home page shows a random pick of drugs; tests fix it, and count the picks.
const sample = vi.hoisted(() => vi.fn((): readonly string[] => ['ibuprofen', 'naproxen']))
vi.mock('./featured.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./featured.ts')>()),
  sampleDrugs: sample,
}))

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  )
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the API as online when health check passes', async () => {
    mockFetch(200, { status: 'ok' })
    render(<App />)
    expect(await screen.findByText('API: online')).toBeInTheDocument()
  })

  it('shows the API as offline when health check fails', async () => {
    mockFetch(500, {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'boom',
    })
    render(<App />)
    expect(await screen.findByText('API: offline')).toBeInTheDocument()
  })

  it('treats a malformed health response as offline', async () => {
    mockFetch(200, { status: 'maybe' })
    render(<App />)
    expect(await screen.findByText('API: offline')).toBeInTheDocument()
  })

  it('names the drug a search resolves to by its ingredients', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname
        const body =
          path === '/api/drugs/resolve'
            ? {
                query: 'Tylenol PM',
                rxcui: '214181',
                ingredients: [
                  { rxcui: '161', name: 'acetaminophen' },
                  { rxcui: '3498', name: 'diphenhydramine' },
                ],
              }
            : path === '/api/drugs/suggestions'
              ? { query: 'Tylenol PM', names: [] }
              : { status: 'ok' }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: /drug name/i }), {
      target: { value: 'Tylenol PM' },
    })
    fireEvent.submit(screen.getByRole('search'))

    expect(
      await screen.findByRole('heading', { name: 'acetaminophen and diphenhydramine' }),
    ).toBeInTheDocument()
  })

  it('drops the previous drug when a new lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost')
        if (url.pathname === '/api/drugs/resolve') {
          return url.searchParams.get('name') === 'Advil'
            ? new Response(
                JSON.stringify({
                  query: 'Advil',
                  rxcui: '5640',
                  ingredients: [{ rxcui: '5640', name: 'ibuprofen' }],
                }),
              )
            : new Response(
                JSON.stringify({
                  type: 'about:blank',
                  title: 'Not Found',
                  status: 404,
                  detail: "No drug found named 'xyzzy'.",
                }),
                { status: 404 },
              )
        }
        return new Response(JSON.stringify({ status: 'ok' }))
      }),
    )
    render(<App />)
    const input = screen.getByRole('combobox', { name: /drug name/i })
    fireEvent.change(input, { target: { value: 'Advil' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByRole('heading', { name: 'ibuprofen' })).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'xyzzy' } })
    fireEvent.submit(screen.getByRole('search'))

    expect(await screen.findByText("No drug found named 'xyzzy'.")).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'ibuprofen' })).not.toBeInTheDocument()
  })

  it('puts the brand and the search in the sidebar', () => {
    mockFetch(200, { status: 'ok' })
    render(<App />)
    const sidebar = screen.getByRole('complementary', { name: 'Search and questions' })

    expect(within(sidebar).getByRole('heading', { level: 1, name: 'rx-jev' })).toBeInTheDocument()
    expect(within(sidebar).getByRole('combobox', { name: /drug name/i })).toBeInTheDocument()
  })

  it('invites a search before any drug is chosen', () => {
    mockFetch(200, { status: 'ok' })
    render(<App />)

    expect(
      within(screen.getByRole('main')).getByText(/search for a drug to see what its label says/i),
    ).toBeInTheDocument()
  })

  it('shows drugs to try on the home page', () => {
    mockFetch(200, { status: 'ok' })
    render(<App />)
    const list = within(screen.getByRole('main')).getByRole('list', { name: 'Drugs to try' })

    expect(within(list).getByRole('button', { name: 'ibuprofen' })).toBeInTheDocument()
  })

  it('looks up a drug picked from the home page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost')
        const body =
          url.pathname === '/api/drugs/resolve' && url.searchParams.get('name') === 'ibuprofen'
            ? {
                query: 'ibuprofen',
                rxcui: '5640',
                ingredients: [{ rxcui: '5640', name: 'ibuprofen' }],
              }
            : { status: 'ok' }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'ibuprofen' }))

    expect(await screen.findByRole('heading', { name: 'ibuprofen' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /drug name/i })).toHaveValue('ibuprofen')
    expect(screen.queryByRole('list', { name: 'Drugs to try' })).not.toBeInTheDocument()
  })

  it('goes back to the home page from the Home button beside the brand', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname
        const body =
          path === '/api/drugs/resolve'
            ? { query: 'Advil', rxcui: '5640', ingredients: [{ rxcui: '5640', name: 'ibuprofen' }] }
            : path === '/api/drugs/suggestions'
              ? { query: 'Advil', names: [] }
              : { status: 'ok' }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    render(<App />)
    const input = screen.getByRole('combobox', { name: /drug name/i })
    fireEvent.change(input, { target: { value: 'Advil' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByRole('heading', { name: 'ibuprofen' })).toBeInTheDocument()

    const sidebar = screen.getByRole('complementary', { name: 'Search and questions' })
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Home' }))

    expect(screen.queryByRole('heading', { name: 'ibuprofen' })).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Drugs to try' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /drug name/i })).toHaveValue('')
  })

  it('shows a fresh pick of drugs each time Home is pressed', () => {
    mockFetch(200, { status: 'ok' })
    sample.mockReturnValueOnce(['ibuprofen', 'naproxen']).mockReturnValueOnce(['aspirin'])
    render(<App />)
    expect(screen.getByRole('button', { name: 'naproxen' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Home' }))

    const list = screen.getByRole('list', { name: 'Drugs to try' })
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['aspirin'])
  })

  it('stays home when a lookup started before Home finishes afterwards', async () => {
    let finish: (() => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname
        if (path === '/api/drugs/resolve') {
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          return new Response(
            JSON.stringify({
              query: 'ibuprofen',
              rxcui: '5640',
              ingredients: [{ rxcui: '5640', name: 'ibuprofen' }],
            }),
          )
        }
        return new Response(JSON.stringify({ status: 'ok' }))
      }),
    )
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'ibuprofen' }))
    await waitFor(() => expect(finish).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    finish?.()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled())
    expect(screen.queryByRole('heading', { name: 'ibuprofen' })).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Drugs to try' })).toBeInTheDocument()
  })

  it('lists the questions in the sidebar and answers in the main area', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname
        const body =
          path === '/api/drugs/resolve'
            ? { query: 'Advil', rxcui: '5640', ingredients: [{ rxcui: '5640', name: 'ibuprofen' }] }
            : path === '/api/labels/5640/answers'
              ? {
                  rxcui: '5640',
                  ingredients: [{ rxcui: '5640', name: 'ibuprofen' }],
                  labels: [labelAnswers()],
                  sources: sourceTrace(),
                }
              : path === '/api/drugs/suggestions'
                ? { query: 'Advil', names: [] }
                : { status: 'ok' }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: /drug name/i }), {
      target: { value: 'Advil' },
    })
    fireEvent.submit(screen.getByRole('search'))

    const sidebar = screen.getByRole('complementary', { name: 'Search and questions' })
    fireEvent.click(await within(sidebar).findByRole('button', { name: 'Pregnancy' }))

    const main = screen.getByRole('main')
    expect(
      within(main).getByRole('heading', { name: 'What the label says about pregnancy' }),
    ).toBeInTheDocument()
    expect(within(main).queryByRole('button', { name: 'Pregnancy' })).not.toBeInTheDocument()
    expect(within(main).getByRole('heading', { name: 'ibuprofen' })).toBeInTheDocument()
  })

  it('always shows the demo caution strip', () => {
    mockFetch(200, { status: 'ok' })
    render(<App />)

    const caution = screen.getByRole('note', { name: 'Caution' })
    expect(caution).toHaveTextContent('Demo project, not medical advice.')
    expect(caution).toHaveTextContent('no pharmacist has checked them')
    // Kept to one line; each answer card carries the pharmacist note.
    expect(caution).not.toHaveTextContent('Talk to a pharmacist')
    expect(caution.textContent).not.toMatch(/\bsafe\b|allowed|ok to take/i)
  })

  it('always shows how it works, with no way to hide the panel', () => {
    mockFetch(200, { status: 'ok' })
    render(<App />)
    const panel = screen.getByRole('complementary', { name: 'How this answer was made' })

    expect(within(panel).getByText(/never writes/i)).toBeVisible()
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows the API status at the foot of the panel', async () => {
    mockFetch(200, { status: 'ok' })
    render(<App />)
    const panel = screen.getByRole('complementary', { name: 'How this answer was made' })

    expect(await within(panel).findByText('API: online')).toBeInTheDocument()
    const sidebar = screen.getByRole('complementary', { name: 'Search and questions' })
    expect(within(sidebar).queryByText(/API:/)).not.toBeInTheDocument()
  })

  it("adds this session's Jev tokens to the panel", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname
        const body =
          path === '/api/drugs/resolve'
            ? { query: 'Advil', rxcui: '5640', ingredients: [{ rxcui: '5640', name: 'ibuprofen' }] }
            : path === '/api/labels/5640/answers'
              ? {
                  rxcui: '5640',
                  ingredients: [{ rxcui: '5640', name: 'ibuprofen' }],
                  labels: [labelAnswers({ fresh: true, input_tokens: 1000, output_tokens: 24 })],
                  sources: sourceTrace(),
                }
              : path === '/api/labels/5640/ask'
                ? askResponse()
                : path === '/api/drugs/suggestions'
                  ? { query: 'Advil', names: [] }
                  : { status: 'ok' }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: /drug name/i }), {
      target: { value: 'Advil' },
    })
    fireEvent.submit(screen.getByRole('search'))
    const panel = screen.getByRole('complementary', { name: 'How this answer was made' })
    expect(await within(panel).findByText('1,024')).toBeInTheDocument()

    fireEvent.change(await screen.findByRole('textbox', { name: /your own question/i }), {
      target: { value: 'Can I take it with grapefruit juice?' },
    })
    fireEvent.submit(screen.getByRole('form', { name: /your own question/i }))

    expect(await within(panel).findByText('3,185')).toBeInTheDocument()
    expect(within(panel).getByText(/asked live/i)).toBeInTheDocument()
  })
})
