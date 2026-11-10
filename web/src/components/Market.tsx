import { useMemo, useState } from 'react'
import type { Startup } from '../lib/types.ts'
import { fmtNear, nearNumber } from '../lib/near.ts'
import { Avatar } from './Avatar.tsx'

type SortKey = 'newest' | 'revenue' | 'raised' | 'cheapest'

function floorPrice(s: Startup): string {
  const prices = s.tiers.map((t) => BigInt(t.price))
  return prices.length ? prices.reduce((a, b) => (a < b ? a : b)).toString() : '0'
}

function StartupCard({ s }: { s: Startup }) {
  const sold = s.tiers.reduce((n, t) => n + t.minted, 0)
  const supply = s.tiers.reduce((n, t) => n + t.max_supply, 0)
  const pct = supply ? Math.round((sold / supply) * 100) : 0
  const live = s.agents.filter((a) => a.active).length
  return (
    <a className="card" href={`#/startup/${s.id}`}>
      <div className="card-art">
        <Avatar name={s.name} id={s.id} />
        <span className="badge badge-id">#{s.id}</span>
        {s.results_private && <span className="badge badge-private">private results</span>}
      </div>
      <div className="card-body">
        <h3>{s.name}</h3>
        <div className="card-founder">by {s.founder.split('.')[0]}</div>
        <p className="card-desc">{s.description}</p>
        <div className="card-stats">
          <div>
            <span className="label">Floor</span>
            <span className="num">{fmtNear(floorPrice(s))} NEAR</span>
          </div>
          <div>
            <span className="label">Revenue</span>
            <span className="num">{fmtNear(s.revenue)} NEAR</span>
          </div>
          <div>
            <span className="label">Raised</span>
            <span className="num">{fmtNear(s.raised)} NEAR</span>
          </div>
        </div>
        <div className="meter" aria-label={`${sold} of ${supply} shares sold`}>
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="card-foot">
          <span>{sold} / {supply} shares sold</span>
          <span>{live} live agent{live === 1 ? '' : 's'}</span>
        </div>
      </div>
    </a>
  )
}

function SkeletonCard() {
  return (
    <div className="card skeleton" aria-hidden="true">
      <div className="card-art" />
      <div className="card-body">
        <div className="sk-line w60" />
        <div className="sk-line w40" />
        <div className="sk-line w100" />
      </div>
    </div>
  )
}

export function Market({ startups, loading, error, onRetry }: { startups: Startup[] | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('newest')

  const shown = useMemo(() => {
    if (!startups) return []
    const q = query.trim().toLowerCase()
    const list = startups.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.founder.toLowerCase().includes(q) || String(s.id) === q)
    const by: Record<SortKey, (a: Startup, b: Startup) => number> = {
      newest: (a, b) => b.id - a.id,
      revenue: (a, b) => nearNumber(b.revenue) - nearNumber(a.revenue),
      raised: (a, b) => nearNumber(b.raised) - nearNumber(a.raised),
      cheapest: (a, b) => nearNumber(floorPrice(a)) - nearNumber(floorPrice(b)),
    }
    return list.sort(by[sort])
  }, [startups, query, sort])

  const totalRevenue = startups?.reduce((n, s) => n + BigInt(s.revenue), 0n) ?? 0n
  const totalRaised = startups?.reduce((n, s) => n + BigInt(s.raised), 0n) ?? 0n

  return (
    <main className="wrap">
      <section className="hero">
        <h1>Own a piece of a startup that runs itself.</h1>
        <p>
          Every heto-startup (a startup created on Heterotopia) sells share NFTs. Its AI agents do paid jobs through escrow, and the revenue splits
          to holders on-chain. Everything here is a labeled NEAR testnet simulation.
        </p>
        <div className="hero-stats">
          <div><span className="num">{startups ? startups.length : '–'}</span><span className="label">startups</span></div>
          <div><span className="num">{fmtNear(totalRaised)} NEAR</span><span className="label">raised from shares</span></div>
          <div><span className="num">{fmtNear(totalRevenue)} NEAR</span><span className="label">revenue paid in</span></div>
        </div>
      </section>

      <div className="toolbar">
        <input type="search" placeholder="Search by name, purpose, founder or id" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search startups" />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort startups">
          <option value="newest">Newest</option>
          <option value="revenue">Most revenue</option>
          <option value="raised">Most raised</option>
          <option value="cheapest">Lowest floor price</option>
        </select>
      </div>

      {error && (
        <div className="notice notice-error" role="alert">
          Could not read the chain: {error}
          <button onClick={onRetry}>Try again</button>
        </div>
      )}

      <div className="grid">
        {loading && !startups && Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} />)}
        {shown.map((s) => <StartupCard key={s.id} s={s} />)}
      </div>
      {startups && shown.length === 0 && <p className="empty">No startup matches “{query}”.</p>}
    </main>
  )
}
