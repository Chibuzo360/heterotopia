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
