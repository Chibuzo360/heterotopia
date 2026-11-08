import { useState } from 'react'

const MAX_DESCRIPTION = 280
const WALLET_NOTE = 'Creating a heto-startup needs a connected wallet. Wallet connect is the next phase, so this form is a preview for now.'

/** Preview of the create-startup flow. The submit button stays disabled until wallet connect exists. */
export function CreateStartup() {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [tierName, setTierName] = useState('General')
  const [price, setPrice] = useState('0.1')
  const [supply, setSupply] = useState('100')

  const left = MAX_DESCRIPTION - purpose.length
  return (
    <details className="panel create">
      <summary>Create a heto-startup</summary>
      <p className="muted small">
        A heto-startup is a startup created on Heterotopia. Say what it is for in one or two sentences; that text appears on its card and page.
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
          <input value={tierName} onChange={(e) => setTierName(e.target.value)} />
        </label>
        <label className="field">Price (NEAR)
          <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="field">Supply
          <input type="number" min="1" step="1" value={supply} onChange={(e) => setSupply(e.target.value)} />
        </label>
      </div>
      <button className="btn btn-primary" disabled title={WALLET_NOTE}>Create startup</button>
      <p className="muted small">{WALLET_NOTE}</p>
    </details>
  )
}
