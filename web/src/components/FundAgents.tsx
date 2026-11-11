import { useState } from 'react'
import type { Startup } from '../lib/types.ts'
import { fmtNear, toYocto } from '../lib/near.ts'
import { useWallet } from '../lib/walletContext.ts'
import { ActionNote } from './Action.tsx'
import { useAction } from './useAction.ts'

const QUICK = ['0.1', '0.5', '1']

/** How long the agent budget would last if every active agent spent its full daily cap. A worst case, labelled as such. */
export function runwayText(s: Startup): string {
  const budget = BigInt(s.agent_balance)
  const perDay = s.agents.filter((a) => a.active).reduce((sum, a) => sum + BigInt(a.daily_cap), 0n)
  if (budget === 0n) return 'The agent budget is empty. Agents cannot pay anyone until it is topped up.'
  if (perDay === 0n) return 'No active agent can spend this yet.'
  const days = Number((budget * 100n) / perDay) / 100
  if (days >= 365) return 'More than a year, even if every agent spent its full daily cap.'
  return `At least ${days < 10 ? days.toFixed(1) : Math.floor(days)} days if every active agent spent its full daily cap every day.`
}

/** Anyone can top up a startup's agent budget. It is not revenue and the funder cannot spend it. */
export function FundAgents({ s }: { s: Startup }) {
  const { account, call, busy } = useWallet()
  const act = useAction()
  const [amount, setAmount] = useState('0.1')
  const yocto = toYocto(amount)
  const frozen = s.status !== 'Active'
  return (
    <div className="fund">
      <strong>Fund the agents</strong>
      <p className="small muted">
        Add NEAR straight to this startup&rsquo;s agent budget. No platform fee, and it is not revenue, so shareholders&rsquo; earnings do not change.
        You cannot take it back or spend it: only this startup&rsquo;s agents can use it, and only inside their limits.
      </p>
      <p className="small"><span className="muted">Budget </span><b>{fmtNear(s.agent_balance)} NEAR</b> <span className="muted">· {runwayText(s)}</span></p>
      <div className="job-actions">
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in NEAR" style={{ width: '6rem' }} />
        {QUICK.map((q) => <button key={q} type="button" className="btn btn-small" onClick={() => setAmount(q)}>{q}</button>)}
        <button className="btn btn-small btn-primary" disabled={!account || busy || frozen || yocto === null}
          onClick={() => act.run(() => call('fund_agents', { startup_id: s.id }, { deposit: yocto ?? '0' }))}>
          {frozen ? 'Startup is frozen' : 'Fund the agents'}
        </button>
      </div>
      {!account && <p className="small muted">Connect a wallet (top right) to do this.</p>}
      <ActionNote state={act.state} doneText="Funded. The agent budget will update in a moment." />
    </div>
  )
}
