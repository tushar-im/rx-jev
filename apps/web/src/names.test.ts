import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetLoadedNames, loadDrugNames, NAMES_MAX_AGE_MS } from './names.ts'

const LIST = { names: ['advil', 'metFORMIN'], updated_at: '2026-09-25T04:17:00.000Z' }

function serve(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function clearDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('rx-jev')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
}

describe('loadDrugNames', () => {
  beforeEach(async () => {
    forgetLoadedNames()
    await clearDatabase()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the list once and keeps it in IndexedDB', async () => {
    const fetchMock = serve(LIST)

    expect(await loadDrugNames(() => 1_000)).toEqual(LIST.names)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/drugs/names')

    forgetLoadedNames()
    const offline = serve({}, 500)
    expect(await loadDrugNames(() => 2_000)).toEqual(LIST.names)
    expect(offline).not.toHaveBeenCalled()
  })

  it('fetches again once the saved list is a day old', async () => {
    serve(LIST)
    await loadDrugNames(() => 1_000)
    forgetLoadedNames()

    const newer = { names: ['advil', 'advil pm'], updated_at: '2026-09-26T04:17:00.000Z' }
    serve(newer)
    expect(await loadDrugNames(() => 1_000 + NAMES_MAX_AGE_MS + 1)).toEqual(newer.names)
  })

  it('keeps using an old list when the network fails', async () => {
    serve(LIST)
    await loadDrugNames(() => 1_000)
    forgetLoadedNames()

    serve({}, 503)
    expect(await loadDrugNames(() => 1_000 + NAMES_MAX_AGE_MS + 1)).toEqual(LIST.names)
  })

  it('gives up quietly on a malformed list', async () => {
    serve({ names: 'advil' })

    expect(await loadDrugNames(() => 1_000)).toBeNull()
  })

  it('stores nothing but the RxNorm names', async () => {
    serve(LIST)
    await loadDrugNames(() => 1_000)

    const saved = await new Promise<unknown>((resolve) => {
      const open = indexedDB.open('rx-jev')
      open.onsuccess = () => {
        const read = open.result.transaction('rxnorm').objectStore('rxnorm').getAll()
        read.onsuccess = () => {
          open.result.close()
          resolve(read.result)
        }
      }
    })
    expect(saved).toEqual([{ ...LIST, saved_at: 1_000 }])
  })
})
