import { useEffect, useState } from 'react'
import { fetchHealth } from './api.ts'

type ApiStatus = 'checking' | 'online' | 'offline'

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<ApiStatus>('checking')

  useEffect(() => {
    fetchHealth()
      .then(() => setStatus('online'))
      .catch(() => setStatus('offline'))
  }, [])

  return (
    <main>
      <h1>rx-jev</h1>
      <p>Find what a drug label says, without reading all of it.</p>
      <p className="status" data-status={status}>
        API: {status}
      </p>
    </main>
  )
}
