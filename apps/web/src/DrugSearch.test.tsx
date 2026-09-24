import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrugSearch } from './DrugSearch.tsx'
import type { ResolvedDrug } from './api.ts'

type Reply = [status: number, body: unknown]

// Answers each request by its path; unknown paths fail the test.
function mockApi(
  routes: Record<string, (url: URL) => Reply | Promise<Reply>>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const route = routes[url.pathname]
    if (!route) throw new Error(`Unexpected request: ${url.pathname}`)
    const [status, body] = await route(url)
    return new Response(JSON.stringify(body), { status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const suggestions = (url: URL): Reply => {
  const q = url.searchParams.get('q')
  if (q === null) throw new Error('Suggestions requested without a query')
  const names = ['advil', 'advil pm', 'advair'].filter((n) => n.startsWith(q.toLowerCase()))
  return [200, { query: q, names }]
}

const advil: ResolvedDrug = {
  query: 'advil',
  rxcui: '5640',
  ingredients: [{ rxcui: '5640', name: 'ibuprofen' }],
}

function renderSearch(): ReturnType<typeof vi.fn> {
  const onResolved = vi.fn()
  render(<DrugSearch onResolved={onResolved} debounceMs={0} />)
  return onResolved
}

function type(text: string): void {
  fireEvent.change(screen.getByRole('combobox', { name: /drug name/i }), {
    target: { value: text },
  })
}

describe('DrugSearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists RxNorm suggestions as the person types', async () => {
    const fetchMock = mockApi({ '/api/drugs/suggestions': suggestions })
    renderSearch()
    type('adv')

    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['advil', 'advil pm', 'advair'])
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost')
    expect(url.searchParams.get('q')).toBe('adv')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true')
  })

  it('does not ask for suggestions before two characters', async () => {
    const fetchMock = mockApi({ '/api/drugs/suggestions': suggestions })
    renderSearch()
    type('a')

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('resolves a clicked suggestion to its ingredient set', async () => {
    const fetchMock = mockApi({
      '/api/drugs/suggestions': suggestions,
      '/api/drugs/resolve': () => [200, advil],
    })
    const onResolved = renderSearch()
    type('adv')
    fireEvent.click(await screen.findByRole('option', { name: 'advil' }))

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(advil))
    const resolveUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost')
    expect(resolveUrl.searchParams.get('name')).toBe('advil')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('picks a suggestion with the arrow keys and Enter', async () => {
    const fetchMock = mockApi({
      '/api/drugs/suggestions': suggestions,
      '/api/drugs/resolve': () => [200, advil],
    })
    const onResolved = renderSearch()
    type('adv')
    await screen.findAllByRole('option')

    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'advil pm' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    const resolveUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost')
    expect(resolveUrl.searchParams.get('name')).toBe('advil pm')
  })

  it('resolves the typed text when no suggestion is chosen', async () => {
    const fetchMock = mockApi({
      '/api/drugs/suggestions': () => [200, { query: 'advill', names: [] }],
      '/api/drugs/resolve': () => [200, advil],
    })
    const onResolved = renderSearch()
    type('advill')
    fireEvent.submit(screen.getByRole('search'))

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(advil))
    const resolveUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost')
    expect(resolveUrl.searchParams.get('name')).toBe('advill')
  })

  it('says so when no drug matches the name', async () => {
    mockApi({
      '/api/drugs/suggestions': () => [200, { query: 'xyzzy', names: [] }],
      '/api/drugs/resolve': () => [
        404,
        { type: 'about:blank', title: 'Not Found', status: 404, detail: "No drug found named 'xyzzy'." },
      ],
    })
    const onResolved = renderSearch()
    type('xyzzy')
    fireEvent.submit(screen.getByRole('search'))

    expect(await screen.findByRole('alert')).toHaveTextContent("No drug found named 'xyzzy'.")
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('shows a plain message when the search service fails', async () => {
    mockApi({
      '/api/drugs/suggestions': () => [200, { query: 'adv', names: [] }],
      '/api/drugs/resolve': () => [502, { detail: 'secret upstream trace' }],
    })
    renderSearch()
    type('adv')
    fireEvent.submit(screen.getByRole('search'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Search is unavailable right now. Try again later.')
    expect(alert).not.toHaveTextContent('secret')
  })

  it('never selects a suggestion left over from an earlier query', async () => {
    const fetchMock = mockApi({
      '/api/drugs/suggestions': (url) =>
        url.searchParams.get('q') === 'adv' ? suggestions(url) : new Promise<Reply>(() => {}),
    })
    renderSearch()
    type('adv')
    await screen.findAllByRole('option')
    type('tyl')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    const paths = fetchMock.mock.calls.map(
      (c) => new URL(String(c[0]), 'http://localhost').pathname,
    )
    expect(paths).not.toContain('/api/drugs/resolve')
  })

  it('clears the shown drug when a new lookup starts', async () => {
    mockApi({
      '/api/drugs/suggestions': () => [200, { query: 'advil', names: [] }],
      '/api/drugs/resolve': () => new Promise<Reply>(() => {}),
    })
    const onLookupStart = vi.fn()
    render(<DrugSearch onResolved={vi.fn()} onLookupStart={onLookupStart} debounceMs={0} />)
    type('advil')
    fireEvent.submit(screen.getByRole('search'))

    expect(onLookupStart).toHaveBeenCalledOnce()
  })

  it('lets only the latest lookup report its result', async () => {
    const pending = new Map<string, (reply: Reply) => void>()
    mockApi({
      '/api/drugs/suggestions': () => [200, { query: '', names: [] }],
      '/api/drugs/resolve': (url) =>
        new Promise<Reply>((resolve) => pending.set(url.searchParams.get('name') ?? '', resolve)),
    })
    const onResolved = renderSearch()
    type('advil')
    fireEvent.submit(screen.getByRole('search'))
    type('xyzzy')
    fireEvent.submit(screen.getByRole('search'))

    pending.get('xyzzy')?.([
      404,
      {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: "No drug found named 'xyzzy'.",
      },
    ])
    expect(await screen.findByRole('alert')).toHaveTextContent('xyzzy')
    pending.get('advil')?.([200, advil])
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(onResolved).not.toHaveBeenCalledWith(advil)
    expect(screen.getByRole('alert')).toHaveTextContent('xyzzy')
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled()
  })
})
