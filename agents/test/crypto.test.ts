import test from "node:test";
import assert from "node:assert/strict";
import {
  newEncryptionKeypair,
  encryptTo,
  decryptWith,
  MAX_PLAINTEXT_BYTES,
  MAX_SEALED_CHARS,
} from "../src/crypto.js";

test("the customer can open what the swarm sealed", () => {
  const customer = newEncryptionKeypair();
  const sealed = encryptTo(customer.publicKeyHex, "BUY NEAR at 3.68");
  assert.equal(decryptWith(customer.secretKeyHex, sealed), "BUY NEAR at 3.68");
});

test("the sealed text does not contain the plaintext", () => {
  const customer = newEncryptionKeypair();
  const sealed = encryptTo(customer.publicKeyHex, "SECRET SIGNAL");
  assert.ok(!sealed.includes("SECRET"));
  assert.ok(sealed.startsWith("v1:"));
});

test("someone else's key cannot open it", () => {
  const customer = newEncryptionKeypair();
  const stranger = newEncryptionKeypair();
  const sealed = encryptTo(customer.publicKeyHex, "SECRET SIGNAL");
  assert.equal(decryptWith(stranger.secretKeyHex, sealed), null);
});

test("a tampered message is refused", () => {
  const customer = newEncryptionKeypair();
  const sealed = encryptTo(customer.publicKeyHex, "SECRET SIGNAL");
  const bytes = Buffer.from(sealed.slice(3), "base64");
  bytes[bytes.length - 1] ^= 1;
  assert.equal(decryptWith(customer.secretKeyHex, "v1:" + bytes.toString("base64")), null);
});

test("sealing the same message twice gives different text", () => {
  const customer = newEncryptionKeypair();
  assert.notEqual(encryptTo(customer.publicKeyHex, "same"), encryptTo(customer.publicKeyHex, "same"));
});

test("a bad customer key is refused", () => {
  assert.throws(() => encryptTo("abcd", "x"), /64 hex/);
  assert.throws(() => encryptTo("zz".repeat(32), "x"), /hex/);
});

test("the biggest allowed result still fits the on-chain limit", () => {
  const customer = newEncryptionKeypair();
  const sealed = encryptTo(customer.publicKeyHex, "x".repeat(MAX_PLAINTEXT_BYTES));
  assert.ok(sealed.length <= MAX_SEALED_CHARS, `sealed length ${sealed.length}`);
  assert.equal(decryptWith(customer.secretKeyHex, sealed), "x".repeat(MAX_PLAINTEXT_BYTES));
});

test("a result that is too long is refused", () => {
  const customer = newEncryptionKeypair();
  assert.throws(() => encryptTo(customer.publicKeyHex, "x".repeat(MAX_PLAINTEXT_BYTES + 1)), /limit/);
  assert.throws(() => encryptTo(customer.publicKeyHex, ""), /Nothing/);
});

test("non-ASCII text survives", () => {
  const customer = newEncryptionKeypair();
  const sealed = encryptTo(customer.publicKeyHex, "Ọ̀gbọ́n 🚀");
  assert.equal(decryptWith(customer.secretKeyHex, sealed), "Ọ̀gbọ́n 🚀");
});

test("garbage input does not throw", () => {
  const customer = newEncryptionKeypair();
  assert.equal(decryptWith(customer.secretKeyHex, "not sealed"), null);
  assert.equal(decryptWith(customer.secretKeyHex, "v1:AAAA"), null);
});

