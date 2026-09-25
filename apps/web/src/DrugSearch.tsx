import { suggest } from '@rx-jev/contract/suggest'
import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, fetchSuggestions, resolveDrug, type ResolvedDrug } from './api.ts'

const MIN_QUERY = 2
const UNAVAILABLE = 'Search is unavailable right now. Try again later.'

type Suggested = { query: string; names: string[] }

type Props = {
  onResolved: (drug: ResolvedDrug) => void
  // Called as each lookup starts, so a failed lookup never leaves an old drug shown.
  onLookupStart?: () => void
  debounceMs?: number
  // RxNorm's name list for matching suggestions locally; null when it cannot load, and then
  // suggestions come from the API.
  loadNames?: () => Promise<readonly string[] | null>
}

// A combobox over RxNorm names. Choosing a suggestion, or submitting typed text, resolves
// the name to the ingredient-set RxCUI the answers route takes.
export function DrugSearch({
  onResolved,
  onLookupStart,
  debounceMs = 200,
  loadNames,
}: Props): React.JSX.Element {
  const id = useId()
  const listId = `${id}-list`
  const [text, setText] = useState('')
  // The name last chosen, so filling the box with it does not reopen the list.
  const [chosen, setChosen] = useState<string | null>(null)
  // Suggestions with the query that produced them, so an older list is never offered.
  const [result, setResult] = useState<Suggested | null>(null)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // RxNorm's names for local matching, once loaded; until then the API suggests.
  const [localNames, setLocalNames] = useState<readonly string[] | null>(null)
  // Only the latest lookup may report its result.
  const lookup = useRef(0)
  const query = text.trim()
  const names = result?.query === query ? result.names : []

  useEffect(() => {
    if (!loadNames) return
    let live = true
    loadNames()
      .then((list) => {
        if (live) setLocalNames(list)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [loadNames])

  useEffect(() => {
    if (query.length < MIN_QUERY || text === chosen) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (localNames !== null) {
        setResult({ query, names: suggest(localNames, query) })
        return
      }
      fetchSuggestions(query, controller.signal)
        .then((found) => setResult({ query, names: found.names }))
        // Suggestions are a convenience; typed text can still be submitted.
        .catch(() => setResult(null))
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, text, chosen, debounceMs, localNames])

  function onType(value: string): void {
    setText(value)
    setActive(-1)
  }

  function choose(name: string): void {
    setText(name)
    setChosen(name)
    setResult(null)
    setActive(-1)
    setError(null)
    setBusy(true)
    onLookupStart?.()
    const id = ++lookup.current
    resolveDrug(name)
      .then((drug) => {
        if (id === lookup.current) onResolved(drug)
      })
      .catch((e: unknown) => {
        if (id !== lookup.current) return
        setError(e instanceof ApiError && e.problem.status === 404 ? e.problem.detail : UNAVAILABLE)
      })
      .finally(() => {
        if (id === lookup.current) setBusy(false)
      })
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (names.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (i + 1) % names.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (i <= 0 ? names.length - 1 : i - 1))
    } else if (event.key === 'Enter' && names[active] !== undefined) {
      event.preventDefault()
      choose(names[active])
    } else if (event.key === 'Escape') {
      setResult(null)
    }
  }

  function onSubmit(event: React.SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    const name = text.trim()
    if (name) choose(name)
  }

  const open = names.length > 0
  return (
    <form role="search" className="drug-search" onSubmit={onSubmit}>
      <label htmlFor={id}>Drug name</label>
      <div className="drug-search-row">
        <input
          id={id}
          role="combobox"
          type="text"
          autoComplete="off"
          placeholder="Brand or generic, e.g. Advil"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          value={text}
          maxLength={100}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setResult(null)}
        />
        <button
          type="submit"
          className="search-button"
          disabled={busy}
          aria-label={busy ? 'Searching' : 'Search'}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        {open && (
          <ul id={listId} role="listbox" aria-label="Suggestions">
            {names.map((name, i) => (
              <li
                key={name}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // Keep focus in the input so its blur does not close the list first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(name)}
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p role="alert" className="search-error">
          {error}
        </p>
      )}
    </form>
  )
}
