import { useEffect, useState } from 'react'
import { fetchAllJobs, fetchClaimable } from './near.ts'

export interface Attention {
  /** Delivered results waiting for the customer to accept or reject. */
  toReview: number
  /** Open orders whose deadline passed with nothing delivered (refund available). */
  toRefund: number
  /** Revenue ready to claim. */
  hasClaim: boolean
  total: number
}

const NONE: Attention = { toReview: 0, toRefund: 0, hasClaim: false, total: 0 }

/** Checks the chain every `everyMs` while the tab is visible, so the page can show what needs the person. */
export function useAttention(account: string | null, version: number, everyMs = 15_000): Attention {
  const [att, setAtt] = useState<Attention>(NONE)
  useEffect(() => {
    if (!account) return
    let cancelled = false
    const check = async () => {
      if (document.hidden) return
      try {
        const [jobs, claimable] = await Promise.all([fetchAllJobs(), fetchClaimable(account)])
        if (cancelled) return
        const now = Date.now()
        const mine = jobs.filter((j) => j.customer === account)
        const toReview = mine.filter((j) => j.status === 'Delivered').length
        const toRefund = mine.filter((j) => j.status === 'Open' && now > j.deadline_ms).length
        const hasClaim = BigInt(claimable) > 0n
        setAtt({ toReview, toRefund, hasClaim, total: toReview + toRefund + (hasClaim ? 1 : 0) })
      } catch { /* keep the last answer; the next check will try again */ }
    }
    void check()
    const id = window.setInterval(check, everyMs)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [account, version, everyMs])
  return account ? att : NONE
}
