import { useEffect, useState } from 'react'
import { fetchClaimable, fmtNear, shortAccount } from '../lib/near.ts'
import { useWallet } from '../lib/walletContext.ts'
import { ActionNote } from './Action.tsx'
import { useAction } from './useAction.ts'

/** Shown only when a wallet is connected: who you are and what you can claim. */
export function AccountBar() {
  const { account, version, call, busy } = useWallet()
  const [claimable, setClaimable] = useState<string | null>(null)
  const claim = useAction()

  useEffect(() => {
    if (!account) return
    let cancelled = false
    fetchClaimable(account).then((v) => { if (!cancelled) setClaimable(v) }).catch(() => { if (!cancelled) setClaimable(null) })
    return () => { cancelled = true }
  }, [account, version])

  if (!account) return null
  const has = claimable !== null && BigInt(claimable) > 0n
  return (
    <div className="accountbar">
      <div className="wrap accountbar-in">
        <span>Signed in as <b className="mono">{shortAccount(account, 30)}</b></span>
        <span>
          Claimable revenue <b className="num">{claimable === null ? '…' : `${fmtNear(claimable)} NEAR`}</b>
        </span>
        <button className="btn btn-small" disabled={!has || busy} onClick={() => claim.run(() => call('claim', {}))}>Claim</button>
        <ActionNote state={claim.state} doneText="Claimed." />
        <a href="#/me" className="accountbar-link">What I hold and ordered →</a>
      </div>
    </div>
  )
}
