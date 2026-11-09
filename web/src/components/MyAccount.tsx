import { useEffect, useMemo, useState } from 'react'
import type { Job, Startup, Token } from '../lib/types.ts'
import { fetchAllJobs, fetchClaimable, fetchTokens, fmtNear, shortAccount, timeAgo } from '../lib/near.ts'
import { useWallet } from '../lib/walletContext.ts'
import { ActionNote } from './Action.tsx'
import { useAction } from './useAction.ts'
import { Avatar } from './Avatar.tsx'
import { JobResult } from './JobResult.tsx'

interface Holding { startupId: number; shares: Map<number, number>; roles: number }

function isShare(t: Token): t is Token & { kind: { Share: { tier: number } } } {
  return typeof t.kind === 'object' && t.kind !== null && 'Share' in t.kind
}

function group(tokens: Token[]): Holding[] {
  const by = new Map<number, Holding>()
  for (const t of tokens) {
    const h = by.get(t.startup_id) ?? { startupId: t.startup_id, shares: new Map<number, number>(), roles: 0 }
    if (isShare(t)) h.shares.set(t.kind.Share.tier, (h.shares.get(t.kind.Share.tier) ?? 0) + 1)
    else h.roles += 1
    by.set(t.startup_id, h)
  }
  return [...by.values()].sort((a, b) => b.startupId - a.startupId)
}

/** One company you hold a stake in. Front: the headline. Back: the detail, and a way to the full page. */
function HoldingCard({ h, s }: { h: Holding; s: Startup | undefined }) {
  const [flipped, setFlipped] = useState(false)
  const total = [...h.shares.values()].reduce((a, b) => a + b, 0)
  const name = s?.name ?? `Startup #${h.startupId}`
  return (
    <div className={`flip${flipped ? ' is-flipped' : ''}`}>
      <div className="flip-inner">
        <div className="flip-face flip-front">
          <Avatar name={name} id={h.startupId} />
          <div className="flip-title">{name}</div>
          <div className="flip-big num">{total} {total === 1 ? 'share' : 'shares'}{h.roles > 0 ? ` + ${h.roles} role` : ''}</div>
          <button className="btn btn-small" onClick={() => setFlipped(true)}>Flip for details</button>
        </div>
        <div className="flip-face flip-back">
          <div className="flip-title">{name} <span className="muted small">#{h.startupId}</span></div>
          <ul className="flip-list">
            {[...h.shares.entries()].sort((a, b) => a[0] - b[0]).map(([tier, n]) => (
              <li key={tier}>
                <span>{s?.tiers[tier]?.name ?? `Tier ${tier}`}</span>
                <span className="num">{n} × {s?.tiers[tier] ? `${fmtNear(s.tiers[tier].price)} NEAR` : ''}</span>
              </li>
            ))}
            {h.roles > 0 && <li><span>Role tokens</span><span className="num">{h.roles}</span></li>}
            {s && <li><span>Startup revenue so far</span><span className="num">{fmtNear(s.revenue)} NEAR</span></li>}
            {s && <li><span>Status</span><span>{s.status}</span></li>}
          </ul>
          <div className="flip-actions">
            <button className="btn btn-small" onClick={() => setFlipped(false)}>Back</button>
            <a className="btn btn-small" href={`#/startup/${h.startupId}`}>More</a>
          </div>
        </div>
      </div>
    </div>
  )
}

function OrderCard({ j, s, onChanged }: { j: Job; s: Startup | undefined; onChanged: () => void }) {
  const { call, busy } = useWallet()
  const act = useAction()
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [now] = useState(() => Date.now())
  const expired = j.status === 'Open' && now > j.deadline_ms
  const reviewOver = j.status === 'Delivered' && now > j.delivered_at_ms + j.review_ms
  const run = (method: string, args: Record<string, unknown>) => act.run(() => call(method, args)).then((ok) => { if (ok) onChanged() })
  return (
    <div className="job">
      <div className="job-head">
        <strong>Order #{j.id}</strong>
        <span className={`pill pill-${j.status.toLowerCase()}`}>{expired ? 'Open · expired' : j.status}</span>
        {j.private && <span className="pill pill-private">private</span>}
        <span className="num">{fmtNear(j.amount)} NEAR</span>
      </div>
      <div>{j.description}</div>
      <div className="small muted">
        <a href={`#/startup/${j.startup_id}`}>{s?.name ?? `Startup #${j.startup_id}`}</a> · placed {timeAgo(j.created_at_ms)}
        {j.agent ? ` · agent ${j.agent.split('.')[0]}` : ''}
        {j.status === 'Open' && !expired ? ` · due ${new Date(j.deadline_ms).toLocaleString()}` : ''}
      </div>
      <JobResult j={j} />
      {j.status === 'Open' && !expired && <p className="small muted">Waiting for an agent to pick this up. If it is not delivered by the due time you can take your payment back.</p>}
      {expired && (
        <div className="job-actions">
          <p className="small warn">Nothing was delivered before the deadline. You get the whole payment back.</p>
          <button className="btn btn-small" disabled={busy} onClick={() => run('refund_job', { job_id: j.id })}>Refund me</button>
        </div>
      )}
      {j.status === 'Delivered' && (
        <div className="job-actions">
          <button className="btn btn-small" disabled={busy} onClick={() => run('accept_job', { job_id: j.id })}>Accept result</button>
          <button className="btn btn-small" disabled={busy} onClick={() => setRejecting((v) => !v)}>Reject…</button>
          {reviewOver && <button className="btn btn-small" disabled={busy} onClick={() => run('settle_job', { job_id: j.id })}>Settle (review window ended)</button>}
          {rejecting && (
            <div className="reject-row">
              <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Why are you rejecting it?" aria-label="Reason for rejecting" />
              <button className="btn btn-small" disabled={busy || reason.trim().length === 0}
                onClick={() => run('reject_job', { job_id: j.id, reason: reason.trim() })}>Send rejection</button>
            </div>
          )}
        </div>
      )}
      <ActionNote state={act.state} doneText="Done." />
    </div>
  )
}

const ORDER_SECTIONS: { title: string; statuses: string[]; hint: string }[] = [
  { title: 'Pending', statuses: ['Open'], hint: 'waiting for an agent' },
  { title: 'Delivered', statuses: ['Delivered'], hint: 'ready for you to accept or reject' },
  { title: 'In dispute', statuses: ['Disputed'], hint: 'waiting for the platform' },
  { title: 'Finished', statuses: ['Paid', 'Refunded'], hint: 'closed' },
]

export function MyAccount({ startups }: { startups: Startup[] | null }) {
  const { account, version, call, busy } = useWallet()
  const claim = useAction()
  const [tokens, setTokens] = useState<Token[] | null>(null)
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [claimable, setClaimable] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!account) return
    let cancelled = false
    Promise.all([fetchTokens(account), fetchAllJobs(), fetchClaimable(account)])
      .then(([t, j, c]) => { if (!cancelled) { setTokens(t); setJobs(j); setClaimable(c); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [account, version, tick])

  const holdings = useMemo(() => group(tokens ?? []), [tokens])
  const mine = useMemo(() => (jobs ?? []).filter((j) => j.customer === account).sort((a, b) => b.id - a.id), [jobs, account])
  const byId = useMemo(() => new Map((startups ?? []).map((s) => [s.id, s])), [startups])
  const refresh = () => { setTick((k) => k + 1); window.setTimeout(() => setTick((k) => k + 1), 4000) }

  if (!account) {
    return (
      <main className="wrap">
        <a className="back" href="#/">← All startups</a>
        <h1>My account</h1>
        <p className="empty">Connect your wallet (top right) to see what you hold and the jobs you ordered.</p>
      </main>
    )
  }
  const has = claimable !== null && BigInt(claimable) > 0n
  return (
    <main className="wrap">
      <a className="back" href="#/">← All startups</a>
      <header className="me-head">
        <div>
          <h1>My account</h1>
          <div className="small muted mono">{shortAccount(account, 36)}</div>
        </div>
        <div className="me-claim">
          <span className="label">Claimable revenue (all startups)</span>
          <span className="num me-claim-num">{claimable === null ? '…' : `${fmtNear(claimable)} NEAR`}</span>
          <button className="btn btn-small" disabled={!has || busy} onClick={() => claim.run(() => call('claim', {})).then((ok) => { if (ok) refresh() })}>Claim</button>
          <ActionNote state={claim.state} doneText="Claimed." />
        </div>
      </header>
      {error && <div className="notice notice-error" role="alert">Could not read the chain: {error}<button onClick={refresh}>Try again</button></div>}

      <section className="panel me-section">
        <h3>What I hold</h3>
        {tokens === null ? <div className="sk-line w100" /> : holdings.length === 0 ? (
          <p className="muted">You do not hold any shares yet. Pick a startup on the <a href="#/">home page</a> and buy one.</p>
        ) : (
          <div className="flip-grid">
            {holdings.map((h) => <HoldingCard key={h.startupId} h={h} s={byId.get(h.startupId)} />)}
          </div>
        )}
      </section>

      <section className="panel me-section">
        <h3>My orders</h3>
        {jobs === null ? <div className="sk-line w100" /> : mine.length === 0 ? (
          <p className="muted">You have not ordered anything yet. Open a startup and use “Place an order”.</p>
        ) : (
          <div className="job-sections">
            {ORDER_SECTIONS.map((sec) => {
              const list = mine.filter((j) => sec.statuses.includes(j.status))
              if (list.length === 0) return null
              return (
                <details key={sec.title} className="job-section" open={sec.title !== 'Finished'}>
                  <summary>
                    <span className="job-section-title">{sec.title}</span>
                    <span className="count">{list.length}</span>
                    <span className="small muted job-section-hint">{sec.hint}</span>
                  </summary>
                  <div className="jobs">{list.map((j) => <OrderCard key={j.id} j={j} s={byId.get(j.startup_id)} onChanged={refresh} />)}</div>
                </details>
              )
            })}
          </div>
        )}
      </section>
    </main>
  )
}
