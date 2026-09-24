import { useEffect, useId, useState } from 'react'
import { ApiError, fetchSuggestions, resolveDrug, type ResolvedDrug } from './api.ts'

const MIN_QUERY = 2
const UNAVAILABLE = 'Search is unavailable right now. Try again later.'

type Props = {
  onResolved: (drug: ResolvedDrug) => void
  debounceMs?: number
}

// A combobox over RxNorm names. Choosing a suggestion, or submitting typed text, resolves
// the name to the ingredient-set RxCUI the answers route takes.
export function DrugSearch({ onResolved, debounceMs = 200 }: Props): React.JSX.Element {
  const id = useId()
  const listId = `${id}-list`
  const [text, setText] = useState('')
  // The name last chosen, so filling the box with it does not reopen the list.
  const [chosen, setChosen] = useState<string | null>(null)
  const [names, setNames] = useState<string[]>([])
  const [active, setActive] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const query = text.trim()
    if (query.length < MIN_QUERY || text === chosen) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchSuggestions(query, controller.signal)
        .then((result) => {
          setNames(result.names)
          setActive(-1)
        })
        // Suggestions are a convenience; typed text can still be submitted.
        .catch(() => setNames([]))
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [text, chosen, debounceMs])

  function onType(value: string): void {
    setText(value)
    if (value.trim().length < MIN_QUERY) setNames([])
  }

  function choose(name: string): void {
    setText(name)
    setChosen(name)
    setNames([])
    setActive(-1)
    setError(null)
    setBusy(true)
    resolveDrug(name)
      .then(onResolved)
      .catch((e: unknown) => {
        setError(e instanceof ApiError && e.problem.status === 404 ? e.problem.detail : UNAVAILABLE)
      })
      .finally(() => setBusy(false))
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
      setNames([])
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
          onBlur={() => setNames([])}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Searching' : 'Search'}
        </button>
      </div>
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
      {error && (
        <p role="alert" className="search-error">
          {error}
        </p>
      )}
    </form>
  )
}
