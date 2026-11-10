import { useEffect, useMemo, useState } from 'react'
import type { Job, Startup, Token } from '../lib/types.ts'
import { fetchAllJobs, fetchClaimable, fetchTokens, fmtNear, shortAccount, timeAgo } from '../lib/near.ts'
import { useWallet } from '../lib/walletContext.ts'
import { ActionNote } from './Action.tsx'
import { useAction } from './useAction.ts'
import { ShareArt, rarityColor } from './ShareArt.tsx'
import { JobResult } from './JobResult.tsx'
import { forgetKeys, keyBackup, rememberOn, savedKeyCount, setRememberKeys } from '../lib/keys.ts'

function isShare(t: Token): t is Token & { kind: { Share: { tier: number } } } {
  return typeof t.kind === 'object' && t.kind !== null && 'Share' in t.kind
}

/** One token you own, drawn like a collectible. Front: the art and headline. Back: the detail and a way to the full page. */
function TokenCard({ t, s }: { t: Token; s: Startup | undefined }) {
  const [flipped, setFlipped] = useState(false)
  const share = isShare(t)
  const tier = share ? t.kind.Share.tier : 0
  const tierInfo = s?.tiers[tier]
  const name = s?.name ?? `Startup #${t.startup_id}`
  const roleName = share ? '' : Object.keys(t.kind)[0] ?? 'Role'
  const rar = share ? rarityColor(tier) : '#e0b54d'
  return (
    <div className={`nft${flipped ? ' is-flipped' : ''}`} style={{ ['--rar' as string]: rar }}>
      <div className="flip-inner">
        <button className="nft-face nft-front" onClick={() => setFlipped(true)} aria-label={`${name} token ${t.token_id}. Flip for details`}>
          <ShareArt seed={`${t.startup_id}:${t.token_id}`} tier={tier} role={!share} label={`Artwork for ${name} token ${t.token_id}`} />
          <div className="nft-meta">
            <div className="nft-row">
              <span className="nft-id mono">#{t.token_id}</span>
              <span className="nft-tier">{share ? tierInfo?.name ?? `Tier ${tier}` : roleName}</span>
            </div>
            <div className="nft-price">{share && tierInfo ? `${fmtNear(tierInfo.price)} NEAR` : share ? 'Share' : 'Role'}</div>
            <div className="nft-sub">{name}</div>
          </div>
        </button>
        <div className="nft-face nft-back">
          <div className="flip-title">{name} <span className="muted small">#{t.startup_id}</span></div>
          <ul className="flip-list">
            <li><span>Token</span><span className="num">{t.token_id}</span></li>
            <li><span>Type</span><span>{share ? `Share · ${tierInfo?.name ?? `tier ${tier}`}` : `Role · ${roleName}`}</span></li>
            {share && tierInfo && <li><span>Price</span><span className="num">{fmtNear(tierInfo.price)} NEAR</span></li>}
            {s && <li><span>Startup revenue</span><span className="num">{fmtNear(s.revenue)} NEAR</span></li>}
            {s && <li><span>Status</span><span>{s.status}</span></li>}
          </ul>
          <div className="flip-actions">
            <button className="btn btn-small" onClick={() => setFlipped(false)}>Back</button>
            <a className="btn btn-small" href={`#/startup/${t.startup_id}`}>More</a>
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
      {j.status === 'Open' && !expired && <p className="small muted">No result yet. An agent program has to pick this up, and this page cannot tell whether one is running. If nothing arrives by the due time you can take your payment back here.</p>}
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
  const [remember, setRemember] = useState(rememberOn())
  const [savedCount, setSavedCount] = useState(0)
  useEffect(() => { setSavedCount(savedKeyCount(account)) }, [account, remember, tick])

  useEffect(() => {
    if (!account) return
    let cancelled = false
    Promise.all([fetchTokens(account), fetchAllJobs(), fetchClaimable(account)])
      .then(([t, j, c]) => { if (!cancelled) { setTokens(t); setJobs(j); setClaimable(c); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [account, version, tick])

  const owned = useMemo(() => (tokens ?? []).slice().sort((a, b) => b.startup_id - a.startup_id || a.token_id.localeCompare(b.token_id, undefined, { numeric: true })), [tokens])
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
        <h3>What I own <span className="count">{tokens?.length ?? 0}</span></h3>
        {tokens === null ? <div className="sk-line w100" /> : owned.length === 0 ? (
          <p className="muted">You do not hold any shares yet. Pick a startup on the <a href="#/">home page</a> and buy one.</p>
        ) : (
          <div className="nft-grid">
            {owned.map((t) => <TokenCard key={t.token_id} t={t} s={byId.get(t.startup_id)} />)}
          </div>
        )}
      </section>

      <section className="panel me-section">
        <h3>My orders</h3>
        <div className="keysettings">
          <label className="small"><input type="checkbox" checked={remember} onChange={(e) => { setRememberKeys(e.target.checked); setRemember(e.target.checked) }} /> Remember my result keys on this device, so private results open by themselves</label>
          <span className="small muted">{savedCount} key{savedCount === 1 ? '' : 's'} saved here.</span>
          {savedCount > 0 && (
            <>
              <button type="button" className="btn btn-small btn-inline" onClick={() => {
                const url = URL.createObjectURL(new Blob([keyBackup(account)], { type: 'application/json' }))
                const a = document.createElement('a'); a.href = url; a.download = 'heto-result-keys.json'; a.click(); URL.revokeObjectURL(url)
              }}>Download backup</button>
              <button type="button" className="btn btn-small btn-inline" onClick={() => { forgetKeys(account); setSavedCount(0) }}>Forget saved keys</button>
            </>
          )}
        </div>
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
