import { useState } from 'react'
import type { Job } from '../lib/types.ts'
import { decryptResult } from '../lib/decrypt.ts'
import { RichText } from './RichText.tsx'
import { CopyButton } from './CopyButton.tsx'
import { loadKey } from '../lib/keys.ts'
import { useWallet } from '../lib/walletContext.ts'

/** Shows what an agent delivered. Public results are text; private ones open with the customer's secret key. */
export function JobResult({ j }: { j: Job }) {
  const [secret, setSecret] = useState('')
  const [plain, setPlain] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const { account } = useWallet()
  if (!j.result) return null
  if (!j.result.startsWith('v1:')) {
    return (
      <div className="result">
        <div className="result-head"><span className="label">Result</span><CopyButton text={j.result} /></div>
        <RichText text={j.result} />
      </div>
    )
  }
  // A key saved on this device opens the result by itself.
  const savedSecret = loadKey(account, j.customer_key)
  const auto = savedSecret && plain === null ? decryptResult(savedSecret, j.result) : null
  const shown = plain ?? auto
  const open = () => {
    const text = decryptResult(secret, j.result ?? '')
    setFailed(text === null)
    setPlain(text)
    if (text !== null) setSecret('') // do not keep the key around once it has worked
  }
  return (
    <div className="result">
      <div className="result-head"><span className="label">Result (encrypted for you)</span>{shown !== null && <CopyButton text={shown} />}</div>
      {shown !== null ? (
        <>
          <RichText text={shown} />
          {auto !== null && <p className="small muted">Opened with the key saved on this device.</p>}
        </>
      ) : (
        <>
          <p className="small muted">Paste the secret key you saved when you placed this order. It is used only in this page and is never sent anywhere.</p>
          <div className="reject-row">
            <input className="mono" type="password" autoComplete="off" value={secret} onChange={(e) => { setSecret(e.target.value); setFailed(false) }}
              placeholder="secret key (64 hex)" aria-label="Your secret key" />
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
