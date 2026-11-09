import { useEffect, useState } from 'react'
import type { Job, Startup } from '../lib/types.ts'
import { CONTRACT_ID, EXPLORER, fetchJobs, fmtNear, nearNumber, shortAccount, timeAgo, toYocto } from '../lib/near.ts'
import { useWallet } from '../lib/walletContext.ts'
import { isValidKey, newKeyPair } from '../lib/keys.ts'
import { ActionNote } from './Action.tsx'
import { useAction } from './useAction.ts'
import { Avatar } from './Avatar.tsx'
import { AgentControls, FounderPanel } from './Manage.tsx'
import { JobResult } from './JobResult.tsx'

const CONNECT_NOTE = 'Connect a wallet (top right) to do this. Browsing stays read-only without one.'

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

const AGENTS_SHOWN = 5

function AgentCard({ a, s }: { a: Startup['agents'][number]; s: Startup }) {
  const { account } = useWallet()
  const used = nearNumber(a.daily_cap) > 0 ? Math.min(100, (nearNumber(a.spent_today) / nearNumber(a.daily_cap)) * 100) : 0
  return (
    <div className="agent">
      <div className="agent-head">
        <div>
          <strong>{a.name}</strong>
          <div className="mono small muted">{a.account_id}</div>
        </div>
        <div className="pills">
          {a.swarm_role && <span className="pill pill-role">{a.swarm_role}</span>}
          <span className={`pill ${a.active ? 'pill-ok' : 'pill-off'}`}>{a.active ? 'active' : 'paused'}</span>
        </div>
      </div>
      {a.model && (
        <div className="small">
          <span className="muted">Model </span><span className="mono">{a.model}</span>
        </div>
      )}
      {a.instructions && (
        <details className="instr">
          <summary className="small muted">Founder’s instructions</summary>
          <p className="small">{a.instructions}</p>
          <p className="small muted">Stored on chain. The agent program reads this before it works; the contract cannot force it to obey, but it does enforce every spending limit below.</p>
        </details>
      )}
      <div className="meter" title="Spent today versus the daily cap"><div className="meter-fill meter-agent" style={{ width: `${used}%` }} /></div>
      <div className="agent-limits">
        <span>Per payment <b>{fmtNear(a.per_tx_cap)} NEAR</b></span>
        <span>Daily cap <b>{fmtNear(a.daily_cap)} NEAR</b></span>
        <span>Spent today <b>{fmtNear(a.spent_today)} NEAR</b></span>
      </div>
      <div className="small muted">May only pay: {a.payees.length ? a.payees.map((p) => shortAccount(p, 30)).join(', ') : 'nobody'}</div>
      {account !== null && account === s.founder && <AgentControls s={s} a={a} />}
    </div>
  )
}

function Agents({ s }: { s: Startup }) {
  const [all, setAll] = useState(false)
  if (s.agents.length === 0) return <p className="muted">No agents hired yet.</p>
  const list = all ? s.agents : s.agents.slice(0, AGENTS_SHOWN)
  const hidden = s.agents.length - AGENTS_SHOWN
  return (
    <>
      <div className="agents">{list.map((a) => <AgentCard key={a.account_id} a={a} s={s} />)}</div>
      {hidden > 0 && (
        <button className="btn btn-small btn-inline" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? 'Show fewer agents' : `Show all ${s.agents.length} agents`}
        </button>
      )}
    </>
  )
}

// Order matters: what needs attention comes first.
const JOB_SECTIONS: { status: string; title: string; hint: string; open: boolean }[] = [
  { status: 'Open', title: 'Open', hint: 'Paid into escrow, waiting for delivery', open: true },
  { status: 'Delivered', title: 'Delivered', hint: 'Result is in; the customer can accept or reject', open: true },
  { status: 'Disputed', title: 'Disputed', hint: 'Rejected by the customer, waiting for the arbiter', open: true },
  { status: 'Paid', title: 'Paid', hint: 'Accepted. The payment became revenue', open: false },
  { status: 'Refunded', title: 'Refunded', hint: 'Not delivered in time or ruled for the customer', open: false },
]

function JobRow({ j }: { j: Job }) {
  const { account, call, busy } = useWallet()
  const act = useAction()
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const mine = account !== null && account === j.customer
  return (
    <div className="job">
      <div className="job-head">
        <strong>Job #{j.id}</strong>
        <span className={`pill pill-${j.status.toLowerCase()}`}>{j.status}</span>
        <span className="num">{fmtNear(j.amount)} NEAR</span>
        {j.private && <span className="pill pill-private">private</span>}
        {mine && <span className="pill pill-role">yours</span>}
      </div>
      <div>{j.description}</div>
      <div className="small muted">
        {shortAccount(j.customer, 30)} · {timeAgo(j.created_at_ms)}
        {j.agent ? ` · agent ${j.agent.split('.')[0]}` : ''}
      </div>
      {(mine || !j.private) && <JobResult j={j} />}
      {mine && j.status === 'Delivered' && (
        <div className="job-actions">
          <button className="btn btn-small" disabled={busy} onClick={() => act.run(() => call('accept_job', { job_id: j.id }))}>Accept result</button>
          <button className="btn btn-small" disabled={busy} onClick={() => setRejecting((v) => !v)}>Reject…</button>
          {rejecting && (
            <div className="reject-row">
              <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Why are you rejecting it?" aria-label="Reason for rejecting" />
              <button className="btn btn-small" disabled={busy || reason.trim().length === 0}
                onClick={() => act.run(() => call('reject_job', { job_id: j.id, reason: reason.trim() }))}>Send rejection</button>
            </div>
          )}
          <ActionNote state={act.state} doneText="Done." />
        </div>
      )}
    </div>
  )
}

function Jobs({ startupId }: { startupId: number }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { version } = useWallet()

  useEffect(() => {
    let cancelled = false
    fetchJobs(startupId)
      .then((j) => { if (!cancelled) { setJobs(j); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [startupId, version])

  if (error) return <p className="notice notice-error">Could not load jobs: {error}</p>
  if (!jobs) return <div className="sk-line w100" />
  if (jobs.length === 0) return <p className="muted">No jobs yet.</p>

  const known = new Set(JOB_SECTIONS.map((x) => x.status))
  const other = jobs.filter((j) => !known.has(j.status))
  const newestFirst = (a: Job, b: Job) => b.id - a.id
  return (
    <div className="job-sections">
      {JOB_SECTIONS.map((sec) => {
        const list = jobs.filter((j) => j.status === sec.status).sort(newestFirst)
        if (list.length === 0) return null
        return (
          <details key={sec.status} className="job-section" open={sec.open}>
            <summary>
              <span className="job-section-title">{sec.title}</span>
              <span className="count">{list.length}</span>
              <span className="small muted job-section-hint">{sec.hint}</span>
            </summary>
            <div className="jobs">{list.map((j) => <JobRow key={j.id} j={j} />)}</div>
          </details>
        )
      })}
      {other.length > 0 && (
        <details className="job-section" open>
          <summary><span className="job-section-title">Other</span><span className="count">{other.length}</span></summary>
          <div className="jobs">{other.sort(newestFirst).map((j) => <JobRow key={j.id} j={j} />)}</div>
        </details>
      )}
    </div>
  )
}

function BuyPanel({ s }: { s: Startup }) {
  const { account, call, busy } = useWallet()
  const [tier, setTier] = useState(0)
  const act = useAction()
  const t = s.tiers[tier]
  const soldOut = !t || t.minted >= t.max_supply
  const frozen = s.status !== 'Active'
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
      <button className="btn btn-primary" disabled={!account || busy || soldOut || frozen} title={account ? undefined : CONNECT_NOTE}
        onClick={() => act.run(() => call('buy_share', { startup_id: s.id, tier_index: tier }, { deposit: t.price }))}>
        {soldOut ? 'Sold out' : frozen ? 'Startup is frozen' : `Buy ${t?.name ?? ''} share for ${t ? fmtNear(t.price) : ''} NEAR`}
      </button>
      {!account && <p className="muted small">{CONNECT_NOTE}</p>}
      <ActionNote state={act.state} doneText="Share bought. It is in your wallet now." />
    </section>
  )
}

const WORK_CHOICES = [
  { label: '1 hour', secs: 3600 },
  { label: '1 day', secs: 86400 },
  { label: '7 days', secs: 604800 },
]

function OrderPanel({ s }: { s: Startup }) {
  const { account, call, busy } = useWallet()
  const act = useAction()
  const [text, setText] = useState('')
  const [pay, setPay] = useState('0.3')
  const [work, setWork] = useState(86400)
  const [key, setKey] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  const yocto = toYocto(pay)
  const needsKey = s.results_private
  const keyOk = !needsKey || isValidKey(key.trim())
  // A key we generated must be saved first, or the result can never be opened.
  const keySafe = secret === null || saved
  const ready = account !== null && text.trim().length > 0 && text.length <= 280 && yocto !== null && keyOk && keySafe

  function generate() {
    const kp = newKeyPair()
    setKey(kp.publicKey)
    setSecret(kp.secretKey)
    setSaved(false)
    setCopied(false)
  }

  async function copySecret() {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="panel">
      <h3>Place an order</h3>
      <p className="muted small">Pay {s.name}’s agents for a job. The money sits in escrow until you accept the result or the review window ends.</p>
      <label className="field">What do you need?
        <textarea rows={3} maxLength={280} value={text} onChange={(e) => setText(e.target.value)} placeholder="Daily NEAR/USDC trading signal" />
      </label>
      <label className="field">Payment (NEAR)
        <input inputMode="decimal" value={pay} onChange={(e) => setPay(e.target.value)} placeholder="0.3" />
      </label>
      <label className="field">Agents have
        <select value={work} onChange={(e) => setWork(Number(e.target.value))}>
          {WORK_CHOICES.map((w) => <option key={w.secs} value={w.secs}>{w.label} to deliver</option>)}
        </select>
      </label>
      {needsKey && (
        <div className="keybox">
          <p className="small">This startup encrypts results. Only the holder of your secret key can open yours.</p>
          <label className="field">Your public key (64 hex characters)
            <input className="mono" value={key} onChange={(e) => { setKey(e.target.value); setSecret(null) }} placeholder="paste yours, or generate a new pair" />
          </label>
          <button type="button" className="btn btn-small" onClick={generate}>Generate a new key pair</button>
          {secret && (
            <div className="secret">
              <p className="small warn">Your SECRET key. It is shown only now and is not stored anywhere. Without it nobody can open your result.</p>
              <code className="mono small">{secret}</code>
              <div>
                <button type="button" className="btn btn-small" onClick={copySecret}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <label className="small"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved my secret key</label>
            </div>
          )}
          {key.trim() !== '' && !isValidKey(key.trim()) && <p className="small warn">That is not a valid key: it must be 64 hex characters, not all zeros.</p>}
        </div>
      )}
      <button className="btn btn-primary" disabled={!ready || busy} title={account ? undefined : CONNECT_NOTE}
        onClick={async () => {
          const ok = await act.run(() => call('create_job', {
            startup_id: s.id,
            description: text.trim(),
            work_secs: work,
            review_secs: null,
            customer_key: needsKey ? key.trim().toLowerCase() : null,
          }, { deposit: yocto ?? '0' }))
          if (ok) {
            setText('')
            setSecret(null)
            setSaved(false)
            setCopied(false)
          }
        }}>
        Pay {pay || '0'} NEAR into escrow
      </button>
      {!account && <p className="muted small">{CONNECT_NOTE}</p>}
      <ActionNote state={act.state} doneText="Order placed. The money is in escrow." />
    </section>
  )
}

export function Detail({ startup, onRefresh }: { startup: Startup | undefined; onRefresh: () => void }) {
  const { account } = useWallet()
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
          <p className="lead">{s.description}</p>
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
          {account !== null && account === s.founder && <FounderPanel key={s.id} s={s} />}
          <BuyPanel s={s} />
          <OrderPanel s={s} />
        </aside>
      </div>
    </main>
  )
}
