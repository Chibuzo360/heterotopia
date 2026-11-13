import { useState } from 'react'
import { toYocto } from '../lib/near.ts'
import type { Startup } from '../lib/types.ts'
import { useWallet } from '../lib/walletContext.ts'
import { ActionNote } from './Action.tsx'
import { useAction } from './useAction.ts'

const MAX_DESCRIPTION = 280
const MAX_TIERS = 8

interface TierDraft { name: string; price: string; supply: string; weight: string }
const FIRST_TIER: TierDraft = { name: 'General', price: '0.1', supply: '100', weight: '1' }

const CONNECT_NOTE = 'Connect a wallet (top right) to create a heto-startup.'

/** Create a heto-startup. Needs a connected wallet; you become its founder. */
export function CreateStartup({ defaultOpen = false, startups = null }: { defaultOpen?: boolean; startups?: Startup[] | null }) {
  const { account, call, busy } = useWallet()
  const act = useAction()
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [tiers, setTiers] = useState<TierDraft[]>([{ ...FIRST_TIER }])

  const left = MAX_DESCRIPTION - purpose.length
  const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const taken = name.trim() ? startups?.find((s) => key(s.name) === key(name)) : undefined
  const parsed = tiers.map((x) => {
    const supply = Number(x.supply)
    const weight = Number(x.weight)
    const price = toYocto(x.price)
    const ok =
      x.name.trim().length >= 1 && x.name.trim().length <= 32 &&
      price !== null &&
      Number.isInteger(supply) && supply >= 1 && supply <= 1_000_000 &&
      Number.isInteger(weight) && weight >= 1 && weight <= 100
    return { ok, name: x.name.trim(), price: price ?? '0', max_supply: supply, weight }
  })
  const names = parsed.map((x) => x.name.toLowerCase())
  const namesUnique = new Set(names).size === names.length
  const ready =
    account !== null &&
    name.trim().length >= 1 && name.trim().length <= 64 && !taken &&
    purpose.trim().length >= 1 && purpose.length <= MAX_DESCRIPTION &&
    parsed.length >= 1 && parsed.length <= MAX_TIERS && parsed.every((x) => x.ok) && namesUnique
  const setTier = (i: number, patch: Partial<TierDraft>) => setTiers((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  return (
    <details className="panel create" open={defaultOpen || undefined}>
      <summary>Create a heto-startup</summary>
      <p className="muted small">
        A heto-startup is a startup created on Heterotopia. Say what it is for in one or two sentences; that text appears on its card and page.
        You become its founder. Revenue is split 60% shareholders, 20% agent budget, 20% operations, and job results are public until you change that.
      </p>
      <div className="create-grid">
        <label className="field full">Name
          <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Signal Desk" aria-invalid={taken ? true : undefined} />
          {taken && <span className="small warn">A startup called &ldquo;{taken.name}&rdquo; already exists (Startup #{taken.id}). Pick a different name so people can tell them apart. This is checked here in the app; the contract itself does not enforce unique names.</span>}
        </label>
        <label className="field full">What is it for?
          <textarea rows={3} value={purpose} maxLength={MAX_DESCRIPTION} onChange={(e) => setPurpose(e.target.value)}
            placeholder="AI agents write a daily NEAR/USDC market signal. Shareholders fund the agents and share the subscription revenue." />
          <span className={`small ${left < 20 ? 'warn' : 'muted'}`}>{left} characters left</span>
        </label>
      </div>
      <div className="tier-editor">
        <strong>Share tiers</strong>
        <p className="muted small">
          Each tier is a kind of share NFT with its own price, supply and weight. A weight of 3 earns three times as much revenue per share as a weight of 1.
          Tiers are fixed when the startup is created, so add them now (up to {MAX_TIERS}).
        </p>
        {tiers.map((x, i) => (
          <div className="tier-row" key={i}>
            <label className="field">{i === 0 ? 'Tier name' : `Tier ${i + 1} name`}
              <input value={x.name} maxLength={32} onChange={(e) => setTier(i, { name: e.target.value })} />
            </label>
            <label className="field">Price (NEAR)
              <input inputMode="decimal" value={x.price} onChange={(e) => setTier(i, { price: e.target.value })} />
            </label>
            <label className="field">Supply
              <input inputMode="numeric" value={x.supply} onChange={(e) => setTier(i, { supply: e.target.value })} />
            </label>
            <label className="field">Weight
              <input inputMode="numeric" value={x.weight} onChange={(e) => setTier(i, { weight: e.target.value })} />
            </label>
            <button type="button" className="btn btn-small btn-danger" disabled={tiers.length === 1} aria-label={`Remove tier ${i + 1}`}
              onClick={() => setTiers((all) => all.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        {!namesUnique && <p className="small warn">Tier names must be different.</p>}
        <button type="button" className="btn btn-small" disabled={tiers.length >= MAX_TIERS}
          onClick={() => setTiers((all) => [...all, { name: '', price: '1', supply: '10', weight: '3' }])}>Add a tier</button>
      </div>
      <button className="btn btn-primary" disabled={!ready || busy} title={account ? undefined : CONNECT_NOTE}
        onClick={async () => {
          const ok = await act.run(() => call('create_startup', {
            name: name.trim(),
            description: purpose.trim(),
            tiers: parsed.map(({ name: n, price, max_supply, weight }) => ({ name: n, price, max_supply, weight })),
            treasury: null,
            allocation: null,
          }))
          if (ok) {
            setName('')
            setPurpose('')
            setTiers([{ ...FIRST_TIER }])
          }
        }}>
        Create startup
      </button>
      {!account && <p className="muted small">{CONNECT_NOTE}</p>}
      <ActionNote state={act.state} doneText="Startup created. Find it under Explore." />
    </details>
  )
}
