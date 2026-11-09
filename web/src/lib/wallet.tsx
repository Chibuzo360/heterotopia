import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { NearConnector } from '@hot-labs/near-connect'
import { CONTRACT_ID } from './near.ts'
import { WalletCtx, type CallOptions, type WalletState } from './walletContext.ts'

const DEFAULT_GAS = '100000000000000' // 100 Tgas; unused gas is refunded

/** Built once. If the browser blocks what the connector needs, the app stays read-only instead of crashing. */
function makeConnector(): { connector: NearConnector | null; error: string | null } {
  try {
    return {
      connector: new NearConnector({ network: 'testnet', features: { testnet: true, signAndSendTransaction: true }, footerBranding: null }),
      error: null,
    }
  } catch (e) {
    return { connector: null, error: e instanceof Error ? e.message : 'Wallet connector could not start' }
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [{ connector, error: unavailable }] = useState(makeConnector)
  const [account, setAccount] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!connector) return
    const onIn = (p: { accounts: { accountId: string }[] }) => setAccount(p.accounts[0]?.accountId ?? null)
    const onOut = () => setAccount(null)
    connector.on('wallet:signIn', onIn)
    connector.on('wallet:signOut', onOut)
    connector.getConnectedWallet()
      .then((r) => setAccount(r.accounts[0]?.accountId ?? null))
      .catch(() => { /* not signed in yet */ })
    return () => {
      connector.off('wallet:signIn', onIn)
      connector.off('wallet:signOut', onOut)
    }
  }, [connector])

  const connect = useCallback(async () => {
    if (!connector) throw new Error(unavailable ?? 'Wallet connector is not ready')
    setBusy(true)
    try {
      await connector.connect()
    } finally {
      setBusy(false)
    }
  }, [connector, unavailable])

  const disconnect = useCallback(async () => {
    if (!connector) return
    await connector.disconnect()
    setAccount(null)
  }, [connector])

  const call = useCallback(async (method: string, args: Record<string, unknown>, opts: CallOptions = {}) => {
    if (!connector || !account) throw new Error('Connect a wallet first')
    setBusy(true)
    try {
      const wallet = await connector.wallet()
      const out = await wallet.signAndSendTransaction({
        receiverId: CONTRACT_ID,
        actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: DEFAULT_GAS, deposit: opts.deposit ?? '0' } }],
      })
      const status = (out as { status?: unknown }).status
      if (status && typeof status === 'object' && 'Failure' in status) {
        throw new Error(`The transaction failed on chain: ${JSON.stringify((status as { Failure: unknown }).Failure).slice(0, 200)}`)
      }
      setVersion((v) => v + 1)
      setTimeout(() => setVersion((v) => v + 1), 4000)
      return (out as { transaction?: { hash?: string } }).transaction?.hash ?? ''
    } finally {
      setBusy(false)
    }
  }, [connector, account])

  const value = useMemo<WalletState>(
    () => ({ account, busy, version, unavailable, connect, disconnect, call }),
    [account, busy, version, unavailable, connect, disconnect, call],
  )
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>
}
