import type { ReactNode } from 'react'

// A small, safe formatter for agent results: paragraphs, "# headings", "- bullets", **bold**, and
// "Label: value" lines. It builds React elements only, never HTML, so a result cannot inject markup.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>)
}

export function RichText({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const out: ReactNode[] = []
  let bullets: string[] = []
  const flush = () => {
    if (bullets.length) {
      out.push(<ul key={`u${out.length}`}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>)
      bullets = []
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') { flush(); continue }
    const bullet = line.match(/^[-*•]\s+(.*)$/)
    if (bullet) { bullets.push(bullet[1]); continue }
    flush()
    const heading = line.match(/^#{1,3}\s+(.*)$/)
    if (heading) { out.push(<h4 key={out.length}>{inline(heading[1])}</h4>); continue }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9 /&()-]{0,28}):\s+(.+)$/)
    if (kv) { out.push(<p key={out.length} className="rt-kv"><span className="rt-key">{kv[1]}</span><span>{inline(kv[2])}</span></p>); continue }
    out.push(<p key={out.length}>{inline(line)}</p>)
  }
  flush()
  return <div className="rich">{out}</div>
}
