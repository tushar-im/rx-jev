import { useEffect, useState } from 'react'
import { fetchHealth, type ResolvedDrug } from './api.ts'
import { DrugAnswers } from './DrugAnswers.tsx'
import { DrugSearch } from './DrugSearch.tsx'

type ApiStatus = 'checking' | 'online' | 'offline'

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<ApiStatus>('checking')
  const [drug, setDrug] = useState<ResolvedDrug | null>(null)
  // The sidebar element the drug's question chips are portalled into.
  const [chipsSlot, setChipsSlot] = useState<HTMLElement | null>(null)

  useEffect(() => {
    fetchHealth()
      .then(() => setStatus('online'))
      .catch(() => setStatus('offline'))
  }, [])

  return (
    <div className="app">
      <div role="note" aria-label="Caution" className="demo-caution">
        <strong>Demo project, not medical advice.</strong> AI picks these quotes from FDA labels and
        no pharmacist has checked them, so an answer can be incomplete or wrong. Talk to a
        pharmacist or doctor before making any decision about a medicine.
      </div>
      <aside className="sidebar" aria-label="Search and questions">
        <h1 className="brand">rx-jev</h1>
        <p className="tagline">What the drug label says, word for word.</p>
        <DrugSearch onResolved={setDrug} onLookupStart={() => setDrug(null)} />
        <div ref={setChipsSlot} className="chips-slot" />
        <p className="status" data-status={status}>
          API: {status}
        </p>
      </aside>
      <main className="stage">
        {drug ? (
          <section aria-live="polite">
            <h2 className="drug-name">{drug.ingredients.map((i) => i.name).join(' and ')}</h2>
            <DrugAnswers key={drug.rxcui} drug={drug} chipsSlot={chipsSlot} />
          </section>
        ) : (
          <p className="invite">
            Search for a drug to see what its label says. Pick a question, or ask your own.
          </p>
        )}
      </main>
    </div>
  )
}
