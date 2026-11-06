// Hi Codex, hi Claude: Asogwa says hi.
//
// Encrypts a job result so that only the customer can read it. The chain only ever sees the
// scrambled text. This is a "sealed box": a fresh one-time key pair per message, X25519 key
// agreement and XSalsa20-Poly1305 authenticated encryption (the NaCl `box` from tweetnacl).
//
// Sealed text layout: PREFIX + base64( ephemeralPublicKey(32) | nonce(24) | ciphertext ).
// The customer's encryption key is separate from their NEAR account key.
import nacl from 'tweetnacl';

export const PREFIX = 'v1:';
/** The contract stores at most 1024 characters per result. */
export const MAX_SEALED_CHARS = 1024;
/** Longest plaintext (bytes) that still fits the on-chain limit after sealing and base64. */
export const MAX_PLAINTEXT_BYTES = 640;

export interface EncryptionKeypair {
  /** Goes on-chain in `create_job` (64 hex characters). */
  publicKeyHex: string;
  /** Never leaves the customer. Whoever holds it can read the results. */
  secretKeyHex: string;
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function fromHex32(hex: string, what: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`${what} must be hex characters only`);
  if (hex.length !== 64) throw new Error(`${what} must be 32 bytes (64 hex characters)`);
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function newEncryptionKeypair(): EncryptionKeypair {
  const kp = nacl.box.keyPair();
  return { publicKeyHex: toHex(kp.publicKey), secretKeyHex: toHex(kp.secretKey) };
}

export function encryptTo(customerPublicKeyHex: string, plaintext: string): string {
  const customerPublic = fromHex32(customerPublicKeyHex, 'Customer key');
  const message = new TextEncoder().encode(plaintext);
  if (message.length === 0) throw new Error('Nothing to seal');
  if (message.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`Result is ${message.length} bytes; the limit is ${MAX_PLAINTEXT_BYTES}`);
  }
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(message, nonce, customerPublic, ephemeral.secretKey);
  const sealed = PREFIX + Buffer.concat([ephemeral.publicKey, nonce, boxed]).toString('base64');
  if (sealed.length > MAX_SEALED_CHARS) throw new Error('Sealed result is too long for the chain');
  return sealed;
}

/** Returns the plaintext, or `null` if this key cannot open the text (wrong key, tampered, or not sealed). */
export function decryptWith(customerSecretKeyHex: string, sealed: string): string | null {
  if (typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) return null;
  const secret = fromHex32(customerSecretKeyHex, 'Secret key');
  const packed = new Uint8Array(Buffer.from(sealed.slice(PREFIX.length), 'base64'));
  if (packed.length < 32 + 24 + nacl.box.overheadLength) return null;
  const opened = nacl.box.open(packed.slice(56), packed.slice(32, 56), packed.slice(0, 32), secret);
  return opened ? new TextDecoder().decode(opened) : null;
}
