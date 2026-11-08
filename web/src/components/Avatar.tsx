// A deterministic picture for each startup, generated from its name. No image upload and no
// contract change needed: the same name always gives the same artwork.
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  return letters.toUpperCase()
}

export function Avatar({ name, id, size = 'card' }: { name: string; id: number; size?: 'card' | 'hero' }) {
  const h = hash(`${name}#${id}`)
  const hue1 = h % 360
  const hue2 = (hue1 + 40 + ((h >> 9) % 80)) % 360
  const gid = `g${id}-${h}`
  const rings = 2 + ((h >> 4) % 3)
  const cx = 30 + ((h >> 8) % 40)
  const cy = 25 + ((h >> 12) % 40)
  const tilt = (h >> 16) % 90
  return (
    <svg className={`avatar avatar-${size}`} viewBox="0 0 100 100" role="img" aria-label={`${name} artwork`} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1" gradientTransform={`rotate(${tilt} .5 .5)`}>
          <stop offset="0" stopColor={`hsl(${hue1} 70% 38%)`} />
          <stop offset="1" stopColor={`hsl(${hue2} 75% 22%)`} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#${gid})`} />
      {Array.from({ length: rings }, (_, i) => (
        <circle key={i} cx={cx} cy={cy} r={18 + i * 16} fill="none" stroke="#fff" strokeOpacity={0.16 - i * 0.03} strokeWidth="1.2" />
      ))}
      <circle cx={cx} cy={cy} r="9" fill={`hsl(${hue2} 90% 70%)`} fillOpacity="0.9" />
      <text x="50" y="86" textAnchor="middle" fontFamily="Space Grotesk, sans-serif" fontWeight="700" fontSize="20" fill="#fff" fillOpacity="0.92" letterSpacing="2">
        {initials(name)}
      </text>
    </svg>
  )
}
