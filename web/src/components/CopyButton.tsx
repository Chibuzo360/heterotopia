import { useState } from 'react'

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="btn btn-small btn-inline" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text)
        setDone(true)
        window.setTimeout(() => setDone(false), 1500)
      } catch { setDone(false) }
    }}>{done ? 'Copied' : label}</button>
  )
}
