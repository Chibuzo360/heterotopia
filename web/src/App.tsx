import { useCallback, useEffect, useState } from 'react'
import type { Startup } from './lib/types.ts'
import { CONTRACT_ID, fetchStartups } from './lib/near.ts'
import { Market } from './components/Market.tsx'
import { Detail } from './components/Detail.tsx'
import { MyAccount } from './components/MyAccount.tsx'
import { AccountBar } from './components/AccountBar.tsx'
import { useWallet, explain } from './lib/walletContext.ts'

/** Tiny hash router: "#/" is the market, "#/startup/3" is startup 3. No dependency needed. */
function useRoute(): { startupId: number | null; me: boolean } {
  const read = () => {
    const m = window.location.hash.match(/^#\/startup\/(\d+)/)
    return { startupId: m ? Number(m[1]) : null, me: window.location.hash.startsWith('#/me') }
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
  const { startupId, me } = useRoute()
  const [startups, setStartups] = useState<Startup[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [reloadKey, setReloadKey] = useState(0)
  const wallet = useWallet()
  const [walletError, setWalletError] = useState<string | null>(null)

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
  }, [reloadKey, wallet.version])

  return (
    <>
      <header className="topbar">
        <div className="wrap topbar-in">
          <a className="brand" href="#/"><span className="brand-mark" />Heterotopia <span className="muted">/ heto</span></a>
          <div className="topbar-right">
            {wallet.account && <a className={`navlink${me ? ' is-here' : ''}`} href="#/me">My account</a>}
            <span className="net">NEAR testnet</span>
            {wallet.account ? (
              <button className="btn btn-small" onClick={() => wallet.disconnect().catch((e) => setWalletError(explain(e)))}>Disconnect</button>
            ) : (
              <button className="btn btn-small" disabled={wallet.busy || wallet.unavailable !== null} title={wallet.unavailable ?? undefined}
                onClick={() => { setWalletError(null); wallet.connect().catch((e) => setWalletError(explain(e))) }}>
                {wallet.busy ? 'Opening wallet…' : 'Connect wallet'}
              </button>
            )}
          </div>
        </div>
      </header>
      <AccountBar />
      {walletError && <div className="wrap"><div className="notice notice-error" role="alert">{walletError}<button onClick={() => setWalletError(null)}>Dismiss</button></div></div>}
      <div className="banner">
        Labeled testnet simulation. No real funds. Agent work runs in dry-run mode and is not financial advice. Contract <span className="mono">{CONTRACT_ID}</span>.
      </div>
      {me ? (
        <MyAccount startups={startups} />
      ) : startupId === null ? (
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
