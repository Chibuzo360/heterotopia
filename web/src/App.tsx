import { useCallback, useEffect, useState } from 'react'
import type { Startup } from './lib/types.ts'
import { CONTRACT_ID, fetchStartups, shortAccount } from './lib/near.ts'
import { Market } from './components/Market.tsx'
import { Detail } from './components/Detail.tsx'
import { CreateStartup } from './components/CreateStartup.tsx'
import { MyAccount } from './components/MyAccount.tsx'
import { useWallet, explain } from './lib/walletContext.ts'
import { useAttention } from './lib/attention.ts'

/** Tiny hash router: "#/" is the market, "#/startup/3" is startup 3. No dependency needed. */
function useRoute(): { startupId: number | null; me: boolean; create: boolean } {
  const read = () => {
    const m = window.location.hash.match(/^#\/startup\/(\d+)/)
    return { startupId: m ? Number(m[1]) : null, me: window.location.hash.startsWith('#/me'), create: window.location.hash.startsWith('#/create') }
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onChange = () => { setRoute(read()); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

type Theme = 'dark' | 'light'

/** Dark by default; follows the system until the person picks one, then remembers it (when the browser allows). */
function useTheme(): [Theme, () => void] {
  const system = (): Theme => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = window.localStorage.getItem('heto-theme')
      if (saved === 'dark' || saved === 'light') return saved
    } catch { /* storage can be blocked; fall through */ }
    return system()
  })
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    try { window.localStorage.setItem('heto-theme', next) } catch { /* ignore */ }
  }
  return [theme, toggle]
}

export default function App() {
  const { startupId, me, create } = useRoute()
  const [theme, toggleTheme] = useTheme()
  const [startups, setStartups] = useState<Startup[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [reloadKey, setReloadKey] = useState(0)
  const wallet = useWallet()
  const [walletError, setWalletError] = useState<string | null>(null)
  const attention = useAttention(wallet.account, wallet.version)
  useEffect(() => {
    document.title = attention.total > 0 ? `(${attention.total}) Heterotopia | startups you can own a piece of` : 'Heterotopia | startups you can own a piece of'
  }, [attention.total])

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
          <nav className="nav" aria-label="Main">
            <a href="#/" className={!me && !create ? 'is-here' : undefined} aria-current={!me && !create ? 'page' : undefined}>Explore</a>
            <a href="#/create" className={create ? 'is-here' : undefined} aria-current={create ? 'page' : undefined}>Create</a>
            <a href="#/me" className={me ? 'is-here' : undefined} aria-current={me ? 'page' : undefined}>
              My account
              {attention.total > 0 && <span className="dot" title={`${attention.toReview} to review, ${attention.toRefund} to refund${attention.hasClaim ? ', revenue to claim' : ''}`} aria-label={`${attention.total} things need you`} />}
            </a>
          </nav>
          <div className="topbar-right">
            <button className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            <span className="net">NEAR testnet</span>
            {wallet.account && <span className="net mono" title={wallet.account}>{shortAccount(wallet.account, 20)}</span>}
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
      {walletError && <div className="wrap"><div className="notice notice-error" role="alert">{walletError}<button onClick={() => setWalletError(null)}>Dismiss</button></div></div>}
      <div className="banner">
        Labeled testnet simulation. No real funds. Agent work runs in dry-run mode and is not financial advice. Contract <span className="mono">{CONTRACT_ID}</span>.
      </div>
      {me ? (
        <MyAccount startups={startups} />
      ) : create ? (
        <main className="wrap">
          <h1 className="page-title">Create a heto-startup</h1>
          <CreateStartup defaultOpen />
        </main>
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
