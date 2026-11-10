import { useState } from 'react'
import type { Agent, Startup } from '../lib/types.ts'
import { toYocto } from '../lib/near.ts'
import { useWallet } from '../lib/walletContext.ts'
import { ActionNote } from './Action.tsx'
import { useAction } from './useAction.ts'

const MAX_DESCRIPTION = 280
const MODEL_HINTS = ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3', 'deepseek/deepseek-v4.1-flash', 'anthropic/claude-haiku-5-5']
const ROLE_HINTS = ['lead', 'worker']
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

function Models() {
  return (
    <>
      <datalist id="model-hints">{MODEL_HINTS.map((m) => <option key={m} value={m} />)}</datalist>
      <datalist id="role-hints">{ROLE_HINTS.map((m) => <option key={m} value={m} />)}</datalist>
    </>
  )
}

/** Directive form for one agent: which model it runs, what it is told, and its place in the swarm. */
function DirectiveForm({ s, a }: { s: Startup; a: Agent }) {
  const { call, busy } = useWallet()
  const act = useAction()
  const [model, setModel] = useState(a.model)
  const [instructions, setInstructions] = useState(a.instructions)
  const [role, setRole] = useState(a.swarm_role)
  const ok = model.trim().length >= 1 && model.length <= 64 && instructions.length <= 500 && role.trim().length >= 1 && role.length <= 32
  return (
    <div className="manage-form">
      <label className="field">Model
        <input list="model-hints" value={model} maxLength={64} onChange={(e) => setModel(e.target.value)} placeholder="z-ai/glm-5.3-flash" />
      </label>
      <label className="field">Swarm role
        <input list="role-hints" value={role} maxLength={32} onChange={(e) => setRole(e.target.value)} placeholder="worker" />
      </label>
      <label className="field">Instructions ({500 - instructions.length} characters left)
        <textarea rows={3} value={instructions} maxLength={500} onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <p className="small muted">Stored on chain. The agent program reads it before it works. It does not change what the agent is allowed to spend.</p>
      <button className="btn btn-small" disabled={!ok || busy}
        onClick={() => act.run(() => call('set_agent_directive', {
          startup_id: s.id, agent_id: a.account_id, model: model.trim(), instructions: instructions.trim(), swarm_role: role.trim(),
        }))}>Save directive</button>
      <ActionNote state={act.state} doneText="Directive saved." />
    </div>
  )
}

/** Buttons shown under an agent card, for the founder only. */
export function AgentControls({ s, a }: { s: Startup; a: Agent }) {
  const { call, busy } = useWallet()
  const act = useAction()
  const [open, setOpen] = useState(false)
  const [now] = useState(() => Date.now())
  const onProbation = a.probation_until > now * 1_000_000
  const id = { startup_id: s.id, agent_id: a.account_id }
  return (
    <div className="manage">
      <Models />
      <div className="job-actions">
        <button className="btn btn-small" disabled={busy} onClick={() => act.run(() => call('set_agent_active', { ...id, active: !a.active }))}>
          {a.active ? 'Pause' : 'Resume'}
        </button>
        {onProbation && (
          <button className="btn btn-small" disabled={busy} onClick={() => act.run(() => call('promote_agent', id))}>End probation</button>
        )}
        <button className="btn btn-small" disabled={busy} onClick={() => setOpen((v) => !v)}>{open ? 'Close directive' : 'Edit directive'}</button>
        <button className="btn btn-small btn-danger" disabled={busy}
          onClick={() => { if (window.confirm(`Remove ${a.account_id} from ${s.name}? It can no longer spend.`)) void act.run(() => call('remove_agent', id)) }}>
          Remove
        </button>
      </div>
      {onProbation && <p className="small muted">On probation: limited to 10% of its caps until it ends.</p>}
      <ActionNote state={act.state} doneText="Done." />
      {open && <DirectiveForm s={s} a={a} />}
    </div>
  )
}

function HireForm({ s }: { s: Startup }) {
  const { call, busy } = useWallet()
  const act = useAction()
  const [account, setAccount] = useState('')
  const [name, setName] = useState('')
  const [perTx, setPerTx] = useState('0.02')
  const [daily, setDaily] = useState('0.05')
  const [payees, setPayees] = useState('')
  const payeeList = payees.split(',').map((p) => p.trim()).filter(Boolean)
  const perYocto = toYocto(perTx)
  const dayYocto = toYocto(daily)
  const accountOk = account.trim().length >= 2 && account.trim().length <= 64 && ACCOUNT_RE.test(account.trim())
  const ok =
    accountOk && name.trim().length >= 1 && name.trim().length <= 32 &&
    perYocto !== null && dayYocto !== null && BigInt(perYocto) <= BigInt(dayYocto) &&
    payeeList.length >= 1 && payeeList.length <= 10 && payeeList.every((p) => ACCOUNT_RE.test(p))
  return (
    <details className="manage-hire">
      <summary>Hire an agent</summary>
      <p className="small muted">
        An agent is a separate program with its own NEAR account and a key that can only call <code>agent_spend</code> and <code>submit_result</code>.
        This form registers an account that already exists. New agents start on probation at 10% of these limits.
      </p>
      <div className="quickfill">
        <span className="small muted">Quick start with the platform's agents (the ones the hosted runner serves):</span>
        <button type="button" className="btn btn-small" onClick={() => { setAccount('agent1.heto3-bybyte.testnet'); setName('Lead'); setPayees('agent2.heto3-bybyte.testnet') }}>Platform lead (agent1)</button>
        <button type="button" className="btn btn-small" onClick={() => { setAccount('agent2.heto3-bybyte.testnet'); setName('Worker') }}>Platform worker (agent2)</button>
      </div>
      <div className="create-grid">
        <label className="field">Agent account
          <input className="mono" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="agent3.heto3-bybyte.testnet" />
        </label>
        <label className="field">Name
          <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Research worker" />
        </label>
        <label className="field">Per payment cap (NEAR)
          <input inputMode="decimal" value={perTx} onChange={(e) => setPerTx(e.target.value)} />
        </label>
        <label className="field">Daily cap (NEAR)
          <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
        </label>
        <label className="field full">May only pay (accounts, comma separated, up to 10)
          <input className="mono" value={payees} onChange={(e) => setPayees(e.target.value)} placeholder="vendor.heto3-bybyte.testnet" />
        </label>
      </div>
      <button className="btn btn-small" disabled={!ok || busy}
        onClick={async () => {
          const done = await act.run(() => call('register_agent', {
            startup_id: s.id, agent_id: account.trim(), name: name.trim(), per_tx_cap: perYocto, daily_cap: dayYocto, payees: payeeList,
          }))
          if (done) {
            setAccount('')
            setName('')
            setPayees('')
          }
        }}>Hire agent</button>
      <ActionNote state={act.state} doneText="Agent hired." />
    </details>
  )
}

/** Everything the founder can change about a heto-startup. Shown only to the founder's wallet. */
export function FounderPanel({ s }: { s: Startup }) {
  const { call, busy } = useWallet()
  const priv = useAction()
  const desc = useAction()
  // null means "not edited": show what is on chain, so a refresh from the chain shows up at once.
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? s.description
  return (
    <section className="panel founder-panel">
      <h3>Manage this startup <span className="pill pill-role">you are the founder</span></h3>
      <Models />
      <div className="manage-block">
        <strong>What it is for</strong>
        <textarea rows={3} value={text} maxLength={MAX_DESCRIPTION} onChange={(e) => setDraft(e.target.value)} aria-label="Startup description" />
        <div className="job-actions">
          <button className="btn btn-small" disabled={busy || text.trim().length === 0 || text.trim() === s.description}
            onClick={async () => {
              if (await desc.run(() => call('set_description', { startup_id: s.id, description: text.trim() }))) setDraft(null)
            }}>Save description</button>
          <span className="small muted">{MAX_DESCRIPTION - text.length} characters left</span>
        </div>
        <ActionNote state={desc.state} doneText="Description saved." />
      </div>
      <div className="manage-block">
        <strong>Job results</strong>
        <p className="small muted">
          {s.results_private
            ? 'Private: results are encrypted for each customer. New customers must supply a key.'
            : 'Public: anyone can read delivered results on chain. Switch to private if customers should be the only readers.'}
        </p>
        <button className="btn btn-small" disabled={busy}
          onClick={() => priv.run(() => call('set_results_private', { startup_id: s.id, private: !s.results_private }))}>
          {s.results_private ? 'Make results public' : 'Make results private'}
        </button>
        <ActionNote state={priv.state} doneText="Updated. Jobs that already exist keep their old setting." />
      </div>
      <HireForm s={s} />
    </section>
  )
}
