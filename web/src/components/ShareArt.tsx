// Original generative artwork for one share token. Nothing is stored or uploaded: the same token id
// always draws the same picture, so it can be re-created anywhere from the token's own data.
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RARITY = ['#5be3a4', '#9fb4ff', '#e0b54d', '#ff8ad8']
export function rarityColor(tier: number): string {
  return RARITY[Math.min(tier, RARITY.length - 1)]
}

export function ShareArt({ seed, tier = 0, role = false, label }: { seed: string; tier?: number; role?: boolean; label: string }) {
  const h = hash(seed)
  const r = rng(h)
  const hue = Math.floor(r() * 360)
  const hue2 = (hue + 50 + Math.floor(r() * 90)) % 360
  const sides = role ? 4 : 5 + Math.floor(r() * 4)
  const rad = 40 + r() * 10
  const cx = 100
  const cy = 88
  const rot = r() * Math.PI
  const pts = Array.from({ length: sides }, (_, i) => {
    const a = rot + (i / sides) * Math.PI * 2
    return [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad] as const
  })
  const poly = pts.map((p) => p.join(',')).join(' ')
  const orbitTilt = -30 + r() * 60
  const orbitAngle = r() * Math.PI * 2
  const sat = [cx + Math.cos(orbitAngle) * 70, cy + Math.sin(orbitAngle) * 22] as const
  const circles = Array.from({ length: 4 }, () => ({ x: r() * 200, y: r() * 150, rr: 30 + r() * 55, o: 0.07 + r() * 0.12 }))
  const stars = Array.from({ length: 16 }, () => ({ x: r() * 200, y: r() * 130, rr: 0.6 + r() * 1.6, o: 0.3 + r() * 0.6 }))
  const wave = (base: number, amp: number) => {
    const ph = r() * 6
    let d = `M0 ${base}`
    for (let x = 0; x <= 200; x += 20) d += ` L${x} ${base + Math.sin(x / 32 + ph) * amp}`
    return d + ' L200 200 L0 200 Z'
  }
  const rar = role ? '#e0b54d' : rarityColor(tier)
  const id = `s${h}`
  return (
    <svg className="nft-art" viewBox="0 0 200 200" role="img" aria-label={label} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 70% 62%)`} />
          <stop offset="1" stopColor={`hsl(${hue2} 65% 30%)`} />
        </linearGradient>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${hue2} 95% 78%)`} />
          <stop offset="0.55" stopColor={`hsl(${hue} 85% 55%)`} />
          <stop offset="1" stopColor={`hsl(${(hue + 300) % 360} 80% 28%)`} />
        </linearGradient>
        <radialGradient id={`${id}r`} cx="0.5" cy="0.44" r="0.5">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}n`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={h % 100} />
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0" />
        </filter>
      </defs>
      <rect width="200" height="200" fill={`url(#${id}b)`} />
      {circles.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r={c.rr} fill="#fff" fillOpacity={c.o} />)}
      <circle cx={cx} cy={cy} r="82" fill={`url(#${id}r)`} />
      {stars.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.rr} fill="#fff" fillOpacity={s.o} />)}
      <path d={wave(150, 5)} fill={`hsl(${hue2} 60% 22%)`} fillOpacity="0.85" />
      <path d={wave(170, 4)} fill={`hsl(${hue} 55% 14%)`} fillOpacity="0.95" />
      <ellipse cx={cx} cy={cy} rx="72" ry="20" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.4" transform={`rotate(${orbitTilt} ${cx} ${cy})`} />
      <polygon points={poly} fill={`url(#${id}g)`} stroke="#fff" strokeOpacity="0.85" strokeWidth="1.6" strokeLinejoin="round" />
      {pts.map((p, i) => <line key={i} x1={cx} y1={cy} x2={p[0]} y2={p[1]} stroke="#fff" strokeOpacity="0.28" strokeWidth="1" />)}
      <polygon points={`${pts[0].join(',')} ${pts[1].join(',')} ${cx},${cy}`} fill="#fff" fillOpacity="0.22" />
      <circle cx={sat[0]} cy={sat[1]} r="4" fill="#fff" />
      <rect width="200" height="200" filter={`url(#${id}n)`} />
      <rect x="0" y="190" width="200" height="10" fill={rar} fillOpacity="0.9" />
    </svg>
  )
}
