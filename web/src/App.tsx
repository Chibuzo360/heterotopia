import { useCallback, useEffect, useState } from 'react'
import type { Startup } from './lib/types.ts'
import { CONTRACT_ID, fetchStartups } from './lib/near.ts'
import { Market } from './components/Market.tsx'
import { Detail } from './components/Detail.tsx'

/** Tiny hash router: "#/" is the market, "#/startup/3" is startup 3. No dependency needed. */
function useRoute(): { startupId: number | null } {
  const read = () => {
    const m = window.location.hash.match(/^#\/startup\/(\d+)/)
    return { startupId: m ? Number(m[1]) : null }
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onChange = () => { setRoute(read()); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export default function App() {
  const { startupId } = useRoute()
  const [startups, setStartups] = useState<Startup[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [reloadKey, setReloadKey] = useState(0)

  // Re-read from the chain when the user asks (Refresh / Try again).
  const load = useCallback(() => {
    setLoading(true)
    setReloadKey((k) => k + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchStartups()
      .then((list) => { if (!cancelled) { setStartups(list); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reloadKey])

  return (
    <>
      <header className="topbar">
        <div className="wrap topbar-in">
          <a className="brand" href="#/"><span className="brand-mark" />Heterotopia <span className="muted">/ heto</span></a>
          <div className="topbar-right">
            <span className="net">NEAR testnet</span>
            <button className="btn btn-small" disabled title="Wallet connect is the next phase">Connect wallet</button>
          </div>
        </div>
      </header>
      <div className="banner">
        Labeled testnet simulation. No real funds. Agent work runs in dry-run mode and is not financial advice. Contract <span className="mono">{CONTRACT_ID}</span>.
      </div>
      {startupId === null ? (
        <Market startups={startups} loading={loading} error={error} onRetry={load} />
      ) : (
        <>
          {error && <div className="wrap"><div className="notice notice-error" role="alert">Could not read the chain: {error}<button onClick={load}>Try again</button></div></div>}
          {loading && !startups ? (
            <main className="wrap"><div className="sk-line w100" /></main>
          ) : (
            <Detail startup={startups?.find((s) => s.id === startupId)} onRefresh={load} />
          )}
        </>
      )}
    </>
  )
}
