import { txLink } from '../lib/near.ts'
import type { ActionState } from './useAction.ts'

export function ActionNote({ state, doneText }: { state: ActionState; doneText: string }) {
  if (state.kind === 'sending') return <p className="small muted" role="status">Waiting for your wallet…</p>
  if (state.kind === 'error') return <p className="small warn" role="alert">{state.message}</p>
  if (state.kind === 'done') {
    return (
      <p className="small ok" role="status">
        {doneText}{' '}
        {state.hash && <a href={txLink(state.hash)} target="_blank" rel="noreferrer">View transaction</a>}
      </p>
    )
  }
  return null
}
