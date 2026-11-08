import { createContext, useContext } from 'react'

export interface CallOptions {
  /** yoctoNEAR as a decimal string. Defaults to "0". */
  deposit?: string
}

export interface WalletState {
  /** Connected account id, or null in read-only mode. */
  account: string | null
  /** True while the wallet window is open or a transaction is being signed. */
  busy: boolean
  /** Bumped after every successful transaction, so pages know to re-read the chain. */
  version: number
  unavailable: string | null
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  /** Call a method on the Heterotopia contract. Returns the transaction hash. */
  call: (method: string, args: Record<string, unknown>, opts?: CallOptions) => Promise<string>
}

export const WalletCtx = createContext<WalletState | null>(null)

export function useWallet(): WalletState {
  const v = useContext(WalletCtx)
  if (!v) throw new Error('useWallet must be used inside <WalletProvider>')
  return v
}

/** Turns whatever a wallet throws into one short sentence. */
export function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const panic = msg.match(/panicked: ([^"\\]+)/)
  if (panic) return `The contract refused it: ${panic[1].trim()}`
  if (/reject|cancel|denied|closed|declined/i.test(msg) && msg.length < 120) return 'You closed or declined the wallet request. Nothing was sent.'
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg
}
