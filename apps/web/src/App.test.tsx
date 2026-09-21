import { render, screen } from '@testing-library/react'
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
})
