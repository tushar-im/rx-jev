import { useEffect, useState } from 'react'
import { fetchHealth, type ResolvedDrug } from './api.ts'
import { DrugAnswers } from './DrugAnswers.tsx'
import { DrugSearch } from './DrugSearch.tsx'

type ApiStatus = 'checking' | 'online' | 'offline'

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<ApiStatus>('checking')
  const [drug, setDrug] = useState<ResolvedDrug | null>(null)

  useEffect(() => {
    fetchHealth()
      .then(() => setStatus('online'))
      .catch(() => setStatus('offline'))
  }, [])

  return (
    <main>
      <h1>rx-jev</h1>
      <p>Find what a drug label says, without reading all of it.</p>
      <DrugSearch onResolved={setDrug} />
      {drug && (
        <section aria-live="polite">
          <h2>{drug.ingredients.map((i) => i.name).join(' and ')}</h2>
          <DrugAnswers key={drug.rxcui} drug={drug} />
        </section>
      )}
      <p className="status" data-status={status}>
        API: {status}
      </p>
    </main>
  )
}
