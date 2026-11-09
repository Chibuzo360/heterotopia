import { useState } from 'react'
import type { Job } from '../lib/types.ts'
import { decryptResult } from '../lib/decrypt.ts'

/** Shows what an agent delivered. Public results are text; private ones open with the customer's secret key. */
export function JobResult({ j }: { j: Job }) {
  const [secret, setSecret] = useState('')
  const [plain, setPlain] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  if (!j.result) return null
  if (!j.result.startsWith('v1:')) {
    return (
      <div className="result">
        <span className="label">Result</span>
        <div className="result-text">{j.result}</div>
      </div>
    )
  }
  const open = () => {
    const text = decryptResult(secret, j.result ?? '')
    setFailed(text === null)
    setPlain(text)
    if (text !== null) setSecret('') // do not keep the key around once it has worked
  }
  return (
    <div className="result">
      <span className="label">Result (encrypted for you)</span>
      {plain !== null ? (
        <div className="result-text">{plain}</div>
      ) : (
        <>
          <p className="small muted">Paste the secret key you saved when you placed this order. It is used only in this page and is never sent anywhere.</p>
          <div className="reject-row">
            <input className="mono" type="password" autoComplete="off" value={secret} onChange={(e) => { setSecret(e.target.value); setFailed(false) }}
              placeholder="your secret key (64 hex characters)" aria-label="Your secret key" />
            <button className="btn btn-small" disabled={secret.trim().length === 0} onClick={open}>Open result</button>
          </div>
          {failed && <p className="small warn" role="alert">That key does not open this result. Check that you used the key saved for this order.</p>}
        </>
      )}
      <button className="btn btn-small" onClick={() => setShowRaw((v) => !v)}>{showRaw ? 'Hide' : 'Show'} the encrypted text</button>
      {showRaw && <textarea className="mono result-sealed" readOnly rows={3} value={j.result} aria-label="Encrypted result" />}
    </div>
  )
}
