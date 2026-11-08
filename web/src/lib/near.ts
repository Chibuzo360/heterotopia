import type { Job, Startup } from './types.ts'

export const CONTRACT_ID = 'heto3-bybyte.testnet'
export const EXPLORER = 'https://testnet.nearblocks.io'

// Tried in order; the first that answers wins.
const RPC_URLS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']

const YOCTO = 10n ** 24n

/** Read-only call to the contract. No wallet and no keys involved. */
export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'heto',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: CONTRACT_ID,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  })
  let lastError = 'No RPC endpoint answered'
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      if (!res.ok) {
        lastError = `${url} returned HTTP ${res.status}`
        continue
      }
      const json = await res.json()
      if (json.error) {
        lastError = json.error.data?.toString() ?? json.error.message ?? 'RPC error'
        continue
      }
      if (json.result?.error) {
        lastError = String(json.result.error)
        continue
      }
      const bytes = new Uint8Array(json.result.result as number[])
      return JSON.parse(new TextDecoder().decode(bytes)) as T
    } catch (e) {
      lastError = `${url}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  throw new Error(lastError)
}

export async function fetchStartups(): Promise<Startup[]> {
  const list = await view<Startup[]>('get_startups', { from_index: 0, limit: 100 })
  return list.slice().sort((a, b) => b.id - a.id) // newest first
}

export function fetchJobs(startupId: number): Promise<Job[]> {
  return view<Job[]>('get_jobs', { startup_id: startupId, from_index: 0, limit: 50 })
}

/** yoctoNEAR string -> readable NEAR amount, at most `decimals` decimals. */
export function fmtNear(yocto: string | bigint, decimals = 4): string {
  const v = BigInt(yocto)
  if (v === 0n) return '0'
  const whole = v / YOCTO
  const frac = (v % YOCTO).toString().padStart(24, '0').slice(0, decimals).replace(/0+$/, '')
  if (whole === 0n && frac === '') return `<${'0.' + '0'.repeat(decimals - 1) + '1'}`
  return frac ? `${whole}.${frac}` : `${whole}`
}

export function nearNumber(yocto: string): number {
  return Number(BigInt(yocto) / 10n ** 18n) / 1e6
}

export function shortAccount(id: string, max = 22): string {
  return id.length <= max ? id : `${id.slice(0, 10)}…${id.slice(-9)}`
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export function fetchClaimable(accountId: string): Promise<string> {
  return view<string>('get_claimable', { account_id: accountId })
}

/** "0.25" -> yoctoNEAR string, without floating point. Returns null for anything that is not a plain positive decimal. */
export function toYocto(text: string): string | null {
  const t = text.trim()
  if (!/^\d+(\.\d{1,24})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  const v = BigInt(whole) * YOCTO + BigInt(frac.padEnd(24, '0'))
  return v > 0n ? v.toString() : null
}

export function txLink(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`
}
