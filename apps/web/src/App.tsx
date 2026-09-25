import { useEffect, useState } from 'react'
import { fetchHealth, type ResolvedDrug } from './api.ts'
import { DrugAnswers } from './DrugAnswers.tsx'
import { DrugSearch, type PickedName } from './DrugSearch.tsx'
import { DrugSphere } from './DrugSphere.tsx'
import { FEATURED_DRUGS } from './featured.ts'
import { loadDrugNames } from './names.ts'
import { HowItWorks, type Session, SessionTotals } from './TracePanel.tsx'

type ApiStatus = 'checking' | 'online' | 'offline'

const NO_USAGE: Session = { tokens: 0, live: 0, stored: 0 }

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<ApiStatus>('checking')
  const [drug, setDrug] = useState<ResolvedDrug | null>(null)
  // Sidebar and panel elements the drug's chips and trace are portalled into.
  const [chipsSlot, setChipsSlot] = useState<HTMLElement | null>(null)
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null)
  const [session, setSession] = useState<Session>(NO_USAGE)
  // A drug picked on the home page, handed to the search to look up.
  const [pick, setPick] = useState<PickedName | null>(null)
  // Bumped by Home to give a fresh, empty search; any lookup in flight is dropped with it.
  const [searchKey, setSearchKey] = useState(0)

  useEffect(() => {
    fetchHealth()
      .then(() => setStatus('online'))
      .catch(() => setStatus('offline'))
  }, [])

  function addUsage(usage: Session): void {
    setSession((s) => ({
      tokens: s.tokens + usage.tokens,
      live: s.live + usage.live,
      stored: s.stored + usage.stored,
    }))
  }

  function goHome(): void {
    setDrug(null)
    setPick(null)
    setSearchKey((k) => k + 1)
  }

  function pickDrug(name: string): void {
    setPick((p) => ({ name, id: (p?.id ?? 0) + 1 }))
  }

  return (
    <div className="app">
      <div role="note" aria-label="Caution" className="demo-caution">
        <strong>Demo project, not medical advice.</strong> AI picks these quotes from FDA labels and
        no pharmacist has checked them, so an answer can be incomplete or wrong.
      </div>
      <aside className="sidebar" aria-label="Search and questions">
        <div className="brand-row">
          <h1 className="brand">rx-jev</h1>
          <button
            type="button"
            className="home-button"
            aria-label="Home"
            title="Home"
            onClick={goHome}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <DrugSearch
          key={searchKey}
          pick={pick}
          onResolved={setDrug}
          onLookupStart={() => setDrug(null)}
          loadNames={loadDrugNames}
        />
        <div ref={setChipsSlot} className="chips-slot" />
      </aside>
      <main className="stage">
        {drug ? (
          <section aria-live="polite">
            <h2 className="drug-name">{drug.ingredients.map((i) => i.name).join(' and ')}</h2>
            <DrugAnswers
              key={drug.rxcui}
              drug={drug}
              chipsSlot={chipsSlot}
              panelSlot={panelSlot}
              onUsage={addUsage}
            />
          </section>
        ) : (
          <>
            <p className="invite">
              Search for a drug to see what its label says. Pick a question, or ask your own.
            </p>
            <DrugSphere names={FEATURED_DRUGS} onPick={pickDrug} />
          </>
        )}
      </main>
      <aside className="panel" aria-label="How this answer was made">
        <h2 className="panel-title">How this answer was made</h2>
        <div className="panel-body">
          {!drug && <HowItWorks />}
          <div ref={setPanelSlot} />
          <SessionTotals session={session} />
        </div>
        <p className="status" data-status={status}>
          API: {status}
        </p>
      </aside>
    </div>
  )
}
