import { useEffect, useState } from 'react'
import { fetchHealth, type ResolvedDrug } from './api.ts'
import { DrugAnswers } from './DrugAnswers.tsx'
import { DrugSearch } from './DrugSearch.tsx'
import { HowItWorks, type Session, SessionTotals } from './TracePanel.tsx'

type ApiStatus = 'checking' | 'online' | 'offline'

const PANEL_KEY = 'rx-jev:panel'
const NO_USAGE: Session = { tokens: 0, live: 0, stored: 0 }

// The panel is on unless this viewer hid it. Storage can be unavailable, so it only
// ever remembers a preference, never anything that must persist.
function panelWasHidden(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === 'hidden'
  } catch {
    return false
  }
}

function rememberPanel(open: boolean): void {
  try {
    if (open) localStorage.removeItem(PANEL_KEY)
    else localStorage.setItem(PANEL_KEY, 'hidden')
  } catch {
    // Not remembered; the panel still toggles for this visit.
  }
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<ApiStatus>('checking')
  const [drug, setDrug] = useState<ResolvedDrug | null>(null)
  // Sidebar and panel elements the drug's chips and trace are portalled into.
  const [chipsSlot, setChipsSlot] = useState<HTMLElement | null>(null)
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null)
  const [panelOpen, setPanelOpen] = useState(() => !panelWasHidden())
  const [session, setSession] = useState<Session>(NO_USAGE)

  useEffect(() => {
    fetchHealth()
      .then(() => setStatus('online'))
      .catch(() => setStatus('offline'))
  }, [])

  function togglePanel(): void {
    rememberPanel(!panelOpen)
    setPanelOpen(!panelOpen)
  }

  function addUsage(usage: Session): void {
    setSession((s) => ({
      tokens: s.tokens + usage.tokens,
      live: s.live + usage.live,
      stored: s.stored + usage.stored,
    }))
  }

  return (
    <div className={panelOpen ? 'app' : 'app panel-closed'}>
      <div role="note" aria-label="Caution" className="demo-caution">
        <strong>Demo project, not medical advice.</strong> AI picks these quotes from FDA labels and
        no pharmacist has checked them, so an answer can be incomplete or wrong.
      </div>
      <aside className="sidebar" aria-label="Search and questions">
        <h1 className="brand">rx-jev</h1>
        <DrugSearch onResolved={setDrug} onLookupStart={() => setDrug(null)} />
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
          <p className="invite">
            Search for a drug to see what its label says. Pick a question, or ask your own.
          </p>
        )}
      </main>
      <aside className="panel" aria-label="How this answer was made">
        <div className="panel-head">
          <h2>How this answer was made</h2>
          <button
            type="button"
            aria-expanded={panelOpen}
            aria-controls="panel-body"
            onClick={togglePanel}
          >
            {panelOpen ? 'Hide' : 'Show'}
          </button>
        </div>
        <div id="panel-body" className="panel-body" hidden={!panelOpen}>
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
