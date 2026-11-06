import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptWith, encryptTo, newEncryptionKeypair, PREFIX } from '../src/crypto.js';
import { checkPayee, levenshtein } from '../src/guard.js';
import { dryRunSignal } from '../src/brain.js';
import { fmt, near, parseEvents } from '../src/near.js';

test('encryption: customer opens, others cannot', () => {
  const a = newEncryptionKeypair();
  const b = newEncryptionKeypair();
  const sealed = encryptTo(a.publicKeyHex, 'BUY NEAR at 3.5');
  assert.ok(sealed.startsWith(PREFIX));
  assert.equal(decryptWith(a.secretKeyHex, sealed), 'BUY NEAR at 3.5');
  assert.equal(decryptWith(b.secretKeyHex, sealed), null);
});

test('encryption: each message is different (fresh ephemeral key and nonce)', () => {
  const a = newEncryptionKeypair();
  assert.notEqual(encryptTo(a.publicKeyHex, 'same'), encryptTo(a.publicKeyHex, 'same'));
});

test('encryption: tampering is detected', () => {
  const a = newEncryptionKeypair();
  const sealed = encryptTo(a.publicKeyHex, 'hello');
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  raw[raw.length - 1] = (raw[raw.length - 1]! ^ 1) & 0xff;
  assert.equal(decryptWith(a.secretKeyHex, PREFIX + raw.toString('base64')), null);
});

test('encryption: garbage and plain text are not decryptable', () => {
  const a = newEncryptionKeypair();
  assert.equal(decryptWith(a.secretKeyHex, 'just text'), null);
  assert.equal(decryptWith(a.secretKeyHex, PREFIX + 'AAAA'), null);
});

test('encryption: rejects a bad customer key', () => {
  assert.throws(() => encryptTo('abcd', 'x'), /32 bytes/);
  assert.throws(() => encryptTo('zz'.repeat(32), 'x'), /hex/);
});

test('a typical signal still fits the 1024 character on-chain limit once encrypted', () => {
  const a = newEncryptionKeypair();
  const text = dryRunSignal({ jobId: 7, description: 'Daily NEAR/USDC trading signal' }, { source: 'stub', nearInUsd: 3.68 });
  assert.ok(encryptTo(a.publicKeyHex, text).length <= 1024);
});

test('guard: exact allowlisted payee passes', () => {
  assert.deepEqual(checkPayee('vendor.x.testnet', ['vendor.x.testnet']), { ok: true });
});

test('guard: look-alikes are flagged', () => {
  for (const fake of ['vend0r.x.testnet', 'vendor.x.testnet.', 'vendorr.x.testnet', 'venclor.x.testnet', 'rnicro.x.testnet']) {
    const allow = fake.startsWith('rnicro') ? ['micro.x.testnet'] : ['vendor.x.testnet'];
    const v = checkPayee(fake, allow);
    assert.equal(v.ok, false, fake);
    assert.equal((v as any).reason, 'look_alike', fake);
  }
});

test('guard: a different account is simply not on the allowlist', () => {
  const v = checkPayee('totally-other-account.testnet', ['vendor.x.testnet']);
  assert.deepEqual(v, { ok: false, reason: 'not_on_allowlist' });
});

test('guard: empty allowlist refuses everything (fail-closed)', () => {
  assert.equal(checkPayee('anyone.testnet', []).ok, false);
});

test('levenshtein basics', () => {
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('abc', 'abd'), 1);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('dry-run signal is deterministic and labelled as simulated', () => {
  const q = { source: 'stub', nearInUsd: 3.5 } as const;
  const a = dryRunSignal({ jobId: 1, description: 'x' }, q);
  assert.equal(a, dryRunSignal({ jobId: 1, description: 'x' }, q));
  assert.match(a, /SIMULATED/);
  assert.match(a, /not financial advice/);
});

test('near(): exact amounts without floating point', () => {
  assert.equal(near('1'), 10n ** 24n);
  assert.equal(near('0.1'), 10n ** 23n);
  assert.equal(near('0.000001'), 10n ** 18n);
  assert.equal(near(2), 2n * 10n ** 24n);
});

test('fmt(): readable NEAR', () => {
  assert.equal(fmt(near('1.5')), '1.5');
  assert.equal(fmt(near('0.396')), '0.396');
  assert.equal(fmt('0'), '0');
});

test('parseEvents keeps only well-formed EVENT_JSON lines', () => {
  const ev = parseEvents([
    'plain log',
    'EVENT_JSON:{"standard":"heto","version":"1.0.0","event":"job_paid","data":[{"job_id":1}]}',
    'EVENT_JSON:{broken',
  ]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.event, 'job_paid');
});
