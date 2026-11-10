import nacl from 'tweetnacl'

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** A fresh X25519 key pair for receiving private job results. Made in the browser; the secret never leaves it. */
export function newKeyPair(): { publicKey: string; secretKey: string } {
  const kp = nacl.box.keyPair()
  return { publicKey: toHex(kp.publicKey), secretKey: toHex(kp.secretKey) }
}

/** The contract wants exactly 64 hex characters and refuses an all-zero key. */
export function isValidKey(text: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(text) && !/^0+$/.test(text)
}

// ---- Keeping result keys on this device ------------------------------------------------------
// The secret key opens private results. It is generated here and never leaves the browser. If the
// person allows it ("remember on this device", on by default), it is kept in this browser's local
// storage per wallet account, so results open by themselves and a lost key cannot lock them out.
// Anyone with access to this browser profile could read it, so the setting can be turned off, and
// the saved keys erased, from My account.
const STORE = 'heto-result-keys-v1'
const FLAG = 'heto-remember-keys'

type KeyBook = Record<string, Record<string, string>>

function readBook(): KeyBook {
  try {
    const raw = window.localStorage.getItem(STORE)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    return parsed && typeof parsed === 'object' ? (parsed as KeyBook) : {}
  } catch {
    return {}
  }
}

export function rememberOn(): boolean {
  try {
    return window.localStorage.getItem(FLAG) !== 'off'
  } catch {
    return false
  }
}

export function setRememberKeys(on: boolean): void {
  try {
    window.localStorage.setItem(FLAG, on ? 'on' : 'off')
  } catch { /* storage unavailable: nothing to do */ }
}

export function saveKey(account: string, publicKey: string, secretKey: string): void {
  if (!rememberOn()) return
  try {
    const book = readBook()
    book[account] = { ...(book[account] ?? {}), [publicKey.toLowerCase()]: secretKey }
    window.localStorage.setItem(STORE, JSON.stringify(book))
  } catch { /* storage unavailable: the person still has the key on screen */ }
}

export function loadKey(account: string | null, publicKey: string | null): string | null {
  if (!account || !publicKey) return null
  return readBook()[account]?.[publicKey.toLowerCase()] ?? null
}

export function savedKeyCount(account: string | null): number {
  return account ? Object.keys(readBook()[account] ?? {}).length : 0
}

export function forgetKeys(account: string): void {
  try {
    const book = readBook()
    delete book[account]
    window.localStorage.setItem(STORE, JSON.stringify(book))
  } catch { /* ignore */ }
}

/** The saved keys of one account as text, so the person can keep their own backup. */
export function keyBackup(account: string): string {
  return JSON.stringify({ account, keys: readBook()[account] ?? {} }, null, 2)
}
