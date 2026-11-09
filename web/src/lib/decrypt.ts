import nacl from 'tweetnacl'

// Mirrors agents/src/crypto.ts. Sealed text = "v1:" + base64( ephemeralPublicKey(32) | nonce(24) | ciphertext ).
const PREFIX = 'v1:'

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** The text, or null when this key cannot open it (wrong key, damaged text, or not sealed). */
export function decryptResult(secretKeyHex: string, sealed: string): string | null {
  if (!sealed.startsWith(PREFIX)) return null
  const secret = hexToBytes(secretKeyHex.trim())
  if (!secret) return null
  let packed: Uint8Array
  try {
    packed = Uint8Array.from(atob(sealed.slice(PREFIX.length)), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  if (packed.length < 32 + 24 + nacl.box.overheadLength) return null
  const opened = nacl.box.open(packed.slice(56), packed.slice(32, 56), packed.slice(0, 32), secret)
  return opened ? new TextDecoder().decode(opened) : null
}
