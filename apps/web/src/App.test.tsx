import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'

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
    mockFetch(500, { type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'boom' })
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
})
