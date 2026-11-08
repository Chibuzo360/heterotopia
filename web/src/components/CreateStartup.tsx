import { useState } from 'react'
import { toYocto } from '../lib/near.ts'
import { useWallet } from '../lib/walletContext.ts'
import { ActionNote } from './Action.tsx'
import { useAction } from './useAction.ts'

const MAX_DESCRIPTION = 280
const CONNECT_NOTE = 'Connect a wallet (top right) to create a heto-startup.'

/** Create a heto-startup. Needs a connected wallet; you become its founder. */
export function CreateStartup() {
  const { account, call, busy } = useWallet()
  const act = useAction()
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [tierName, setTierName] = useState('General')
  const [price, setPrice] = useState('0.1')
  const [supply, setSupply] = useState('100')

  const left = MAX_DESCRIPTION - purpose.length
  const priceYocto = toYocto(price)
  const supplyNum = Number(supply)
  const supplyOk = Number.isInteger(supplyNum) && supplyNum >= 1 && supplyNum <= 1_000_000
  const ready =
    account !== null &&
    name.trim().length >= 1 && name.trim().length <= 64 &&
    purpose.trim().length >= 1 && purpose.length <= MAX_DESCRIPTION &&
    tierName.trim().length >= 1 && tierName.trim().length <= 32 &&
    priceYocto !== null && supplyOk

  return (
    <details className="panel create">
      <summary>Create a heto-startup</summary>
      <p className="muted small">
        A heto-startup is a startup created on Heterotopia. Say what it is for in one or two sentences; that text appears on its card and page.
        You become its founder. Revenue is split 60% shareholders, 20% agent budget, 20% operations, and job results are public until you change that.
      </p>
      <div className="create-grid">
        <label className="field">Name
          <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Signal Desk" />
        </label>
        <label className="field full">What is it for?
          <textarea rows={3} value={purpose} maxLength={MAX_DESCRIPTION} onChange={(e) => setPurpose(e.target.value)}
            placeholder="AI agents write a daily NEAR/USDC market signal. Shareholders fund the agents and share the subscription revenue." />
          <span className={`small ${left < 20 ? 'warn' : 'muted'}`}>{left} characters left</span>
        </label>
        <label className="field">First tier name
          <input value={tierName} maxLength={32} onChange={(e) => setTierName(e.target.value)} />
        </label>
        <label className="field">Price per share (NEAR)
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="field">Supply
          <input inputMode="numeric" value={supply} onChange={(e) => setSupply(e.target.value)} />
        </label>
      </div>
      <button className="btn btn-primary" disabled={!ready || busy} title={account ? undefined : CONNECT_NOTE}
        onClick={() => act.run(() => call('create_startup', {
          name: name.trim(),
          description: purpose.trim(),
          tiers: [{ name: tierName.trim(), price: priceYocto, max_supply: supplyNum, weight: 1 }],
          treasury: null,
          allocation: null,
        }))}>
        Create startup
      </button>
      {!account && <p className="muted small">{CONNECT_NOTE}</p>}
      <ActionNote state={act.state} doneText="Startup created. It appears in the list below." />
    </details>
  )
}
