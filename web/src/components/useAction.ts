import { useCallback, useState } from 'react'
import { explain } from '../lib/walletContext.ts'

export type ActionState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; hash: string }
  | { kind: 'error'; message: string }

/** Runs one wallet action and remembers how it went, so every button reports the same way. */
export function useAction() {
  const [state, setState] = useState<ActionState>({ kind: 'idle' })
  const run = useCallback(async (fn: () => Promise<string>) => {
    setState({ kind: 'sending' })
    try {
      setState({ kind: 'done', hash: await fn() })
    } catch (e) {
      setState({ kind: 'error', message: explain(e) })
    }
  }, [])
  return { state, run }
}
