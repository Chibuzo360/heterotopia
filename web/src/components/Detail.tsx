import { useEffect, useState } from 'react'
import type { Job, Startup } from '../lib/types.ts'
import { CONTRACT_ID, EXPLORER, fetchJobs, fmtNear, nearNumber, shortAccount, timeAgo } from '../lib/near.ts'
import { Avatar } from './Avatar.tsx'

const WALLET_NOTE = 'Wallet connect is the next phase. Browsing is read-only until then.'

function SplitBar({ s }: { s: Startup }) {
  const a = s.allocation
  const parts = [
    { key: 'holders', label: 'Shareholders', bps: a.holders_bps, cls: 'seg-holders' },
    { key: 'agent', label: 'Agent budget', bps: a.agent_bps, cls: 'seg-agent' },
    { key: 'ops', label: 'Operations', bps: a.ops_bps, cls: 'seg-ops' },
  ]
  return (
    <div>
      <div className="split" role="img" aria-label="How each revenue deposit is split">
        {parts.map((p) => <div key={p.key} className={p.cls} style={{ width: `${p.bps / 100}%` }} />)}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.key}><i className={p.cls} />{p.label} {p.bps / 100}%</span>
        ))}
      </div>
      <p className="muted small">
        {a.role_bps / 100}% of the shareholders’ part goes to active role holders. Fixed when the startup was created.
      </p>
    </div>
  )
}

function Buckets({ s }: { s: Startup }) {
  return (
    <div className="stat-grid">
      <div className="stat"><span className="label">Raised from shares</span><span className="num">{fmtNear(s.raised)} NEAR</span></div>
      <div className="stat"><span className="label">Revenue (after fee)</span><span className="num">{fmtNear(s.revenue)} NEAR</span></div>
      <div className="stat"><span className="label">Agent budget left</span><span className="num">{fmtNear(s.agent_balance)} NEAR</span></div>
      <div className="stat"><span className="label">Operations left</span><span className="num">{fmtNear(s.ops_balance)} NEAR</span></div>
    </div>
  )
}

function Tiers({ s }: { s: Startup }) {
  return (
    <div className="tiers">
      {s.tiers.map((t) => {
        const pct = t.max_supply ? (t.minted / t.max_supply) * 100 : 0
        return (
          <div className="tier" key={t.name}>
            <div className="tier-head">
              <strong>{t.name}</strong>
              <span className="num">{fmtNear(t.price)} NEAR</span>
            </div>
            <div className="meter"><div className="meter-fill" style={{ width: `${pct}%` }} /></div>
            <div className="tier-foot">
              <span>{t.minted} / {t.max_supply} sold</span>
              <span>earns {t.weight}× per share</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Agents({ s }: { s: Startup }) {
  if (s.agents.length === 0) return <p className="muted">No agents hired yet.</p>
  return (
    <div className="agents">
      {s.agents.map((a) => {
        const used = nearNumber(a.daily_cap) > 0 ? Math.min(100, (nearNumber(a.spent_today) / nearNumber(a.daily_cap)) * 100) : 0
        return (
          <div className="agent" key={a.account_id}>
            <div className="agent-head">
              <div>
                <strong>{a.name}</strong>
                <div className="mono small muted">{a.account_id}</div>
              </div>
              <span className={`pill ${a.active ? 'pill-ok' : 'pill-off'}`}>{a.active ? 'active' : 'paused'}</span>
            </div>
            <div className="meter" title="Spent today versus the daily cap"><div className="meter-fill meter-agent" style={{ width: `${used}%` }} /></div>
            <div className="agent-limits">
              <span>Per payment <b>{fmtNear(a.per_tx_cap)} NEAR</b></span>
              <span>Daily cap <b>{fmtNear(a.daily_cap)} NEAR</b></span>
              <span>Spent today <b>{fmtNear(a.spent_today)} NEAR</b></span>
            </div>
            <div className="small muted">May only pay: {a.payees.length ? a.payees.map((p) => shortAccount(p, 30)).join(', ') : 'nobody'}</div>
          </div>
        )
      })}
    </div>
  )
}

function Jobs({ startupId }: { startupId: number }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchJobs(startupId)
      .then((j) => { if (!cancelled) { setJobs(j); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [startupId])

  if (error) return <p className="notice notice-error">Could not load jobs: {error}</p>
  if (!jobs) return <div className="sk-line w100" />
  if (jobs.length === 0) return <p className="muted">No jobs yet.</p>
  return (
    <div className="jobs">
      {jobs.map((j) => (
        <div className="job" key={j.id}>
          <div className="job-head">
            <strong>Job #{j.id}</strong>
            <span className={`pill pill-${j.status.toLowerCase()}`}>{j.status}</span>
            <span className="num">{fmtNear(j.amount)} NEAR</span>
            {j.private && <span className="pill pill-private">private</span>}
          </div>
          <div>{j.description}</div>
          <div className="small muted">
            {shortAccount(j.customer, 30)} · {timeAgo(j.created_at_ms)}
            {j.agent ? ` · agent ${j.agent.split('.')[0]}` : ''}
          </div>
        </div>
      ))}
    </div>
  )
}

function BuyPanel({ s }: { s: Startup }) {
  const [tier, setTier] = useState(0)
  const t = s.tiers[tier]
  const soldOut = !t || t.minted >= t.max_supply
  return (
    <section className="panel">
      <h3>Buy a share</h3>
      <div className="choices" role="radiogroup" aria-label="Share tier">
        {s.tiers.map((x, i) => (
          <label key={x.name} className={`choice ${i === tier ? 'choice-on' : ''}`}>
            <input type="radio" name="tier" checked={i === tier} onChange={() => setTier(i)} />
            <span>{x.name}</span>
            <span className="num">{fmtNear(x.price)} NEAR</span>
          </label>
        ))}
      </div>
      <p className="muted small">A 1% platform fee applies to primary sales. Your share NFT earns {t?.weight ?? 0}× revenue per share and you can claim at any time.</p>
      <button className="btn btn-primary" disabled title={WALLET_NOTE}>{soldOut ? 'Sold out' : `Buy ${t?.name ?? ''} share`}</button>
      <p className="muted small">{WALLET_NOTE}</p>
    </section>
  )
}

function OrderPanel({ s }: { s: Startup }) {
  return (
    <section className="panel">
      <h3>Place an order</h3>
      <p className="muted small">Pay {s.name}’s agents for a job. The money sits in escrow until you accept the result or the review window ends.</p>
      <label className="field">What do you need?
        <textarea rows={3} placeholder="Daily NEAR/USDC trading signal" disabled />
      </label>
      <label className="field">Payment (NEAR)
        <input type="number" placeholder="0.3" disabled />
      </label>
      <button className="btn" disabled title={WALLET_NOTE}>Place order</button>
      <p className="muted small">{WALLET_NOTE}</p>
    </section>
  )
}

export function Detail({ startup, onRefresh }: { startup: Startup | undefined; onRefresh: () => void }) {
  if (!startup) {
    return (
      <main className="wrap">
        <a className="back" href="#/">← All startups</a>
        <p className="empty">Startup not found. It may still be loading, or the id is wrong.</p>
      </main>
    )
  }
  const s = startup
  return (
    <main className="wrap">
      <a className="back" href="#/">← All startups</a>
      <header className="detail-head">
        <Avatar name={s.name} id={s.id} size="hero" />
        <div>
          <div className="eyebrow">Startup #{s.id} · {s.status}</div>
          <h1>{s.name}</h1>
          <div className="small muted">
            Founder <span className="mono">{s.founder}</span> · Treasury <span className="mono">{s.treasury}</span>
          </div>
          <div className="small muted">
            Contract <a href={`${EXPLORER}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer" className="mono">{CONTRACT_ID}</a>
            {s.results_private && ' · job results are encrypted for the customer'}
          </div>
          <button className="btn btn-small" onClick={onRefresh}>Refresh</button>
        </div>
      </header>

      <div className="detail-cols">
        <div className="detail-main">
          <section className="panel"><h3>Money</h3><Buckets s={s} /></section>
          <section className="panel"><h3>How each deposit is split</h3><SplitBar s={s} /></section>
          <section className="panel"><h3>Share tiers</h3><Tiers s={s} /></section>
          <section className="panel"><h3>Agents</h3><Agents s={s} /></section>
          <section className="panel"><h3>Jobs (escrow)</h3><Jobs startupId={s.id} /></section>
        </div>
        <aside className="detail-side">
          <BuyPanel s={s} />
          <OrderPanel s={s} />
        </aside>
      </div>
    </main>
  )
}
