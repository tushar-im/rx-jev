import { DrugNamesSchema } from './api.ts'

// RxNorm's display names for autocomplete, kept in the browser so suggestions need no
// request per keystroke. Only this public list is stored: never a looked-up drug, an answer
// or a question.

export const NAMES_MAX_AGE_MS = 86_400_000
const DATABASE = 'rx-jev'
const STORE = 'rxnorm'
const KEY = 'displaynames'

type Saved = { names: string[]; updated_at: string; saved_at: number }

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      // Private windows and blocked storage fall back to the network.
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function read(db: IDBDatabase): Promise<Saved | null> {
  return new Promise((resolve) => {
    const request = db.transaction(STORE).objectStore(STORE).get(KEY)
    request.onsuccess = () => {
      const parsed = DrugNamesSchema.safeParse(request.result)
      const savedAt: unknown = (request.result as { saved_at?: unknown } | undefined)?.saved_at
      resolve(
        parsed.success && typeof savedAt === 'number'
          ? { ...parsed.data, saved_at: savedAt }
          : null,
      )
    }
    request.onerror = () => resolve(null)
  })
}

function write(db: IDBDatabase, saved: Saved): Promise<void> {
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(saved, KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
  })
}

async function fetchNames(): Promise<{ names: string[]; updated_at: string } | null> {
  try {
    const response = await fetch('/api/drugs/names', { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const parsed = DrugNamesSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function load(now: () => number): Promise<readonly string[] | null> {
  const db = await openDatabase()
  try {
    const saved = db ? await read(db) : null
    if (saved && now() - saved.saved_at < NAMES_MAX_AGE_MS) return saved.names
    const fresh = await fetchNames()
    if (fresh === null) return saved?.names ?? null
    if (db) await write(db, { ...fresh, saved_at: now() })
    return fresh.names
  } finally {
    // Closed after each load, so another tab can upgrade or clear the database.
    db?.close()
  }
}

let loaded: Promise<readonly string[] | null> | null = null

/** The name list, loaded once per page: from IndexedDB, or the API when a day old. */
export function loadDrugNames(now: () => number = Date.now): Promise<readonly string[] | null> {
  loaded ??= load(now)
  return loaded
}

/** Forgets the list loaded by this page, so the next call reads storage again. For tests. */
export function forgetLoadedNames(): void {
  loaded = null
}
