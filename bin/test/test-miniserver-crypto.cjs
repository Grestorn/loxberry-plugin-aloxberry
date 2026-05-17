#!/usr/bin/env node
// Unit tests for miniserver-crypto. Pure-math, no network.
'use strict';

const crypto = require('node:crypto');
const c = require('../src/miniserver-crypto');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, detail) { console.log(`  ✗ ${label}${detail ? ': ' + detail : ''}`); fail++; }
function check(cond, label, detail) { (cond ? ok : nope)(label, detail); }

function test(name, fn) {
  console.log(`# ${name}`);
  try { fn(); } catch (err) { nope('threw', err.stack || err.message); }
  console.log('');
}

// --- AES session key + RSA round-trip -------------------------------------
test('generateAesSessionKey yields 32+16 bytes of randomness', () => {
  const a = c.generateAesSessionKey();
  const b = c.generateAesSessionKey();
  check(a.aesKey.length === 32, 'aesKey 32 bytes');
  check(a.aesIv.length === 16, 'aesIv 16 bytes');
  check(!a.aesKey.equals(b.aesKey), 'keys are random');
  check(!a.aesIv.equals(b.aesIv), 'IVs are random');
});

test('RSA keyexchange round-trip using a locally-generated keypair', () => {
  // Generate a test keypair to verify the encrypt path. Decrypt locally
  // (the Miniserver would decrypt for real) to confirm the wire format.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { aesKey, aesIv } = c.generateAesSessionKey();
  const b64 = c.rsaEncryptKeyExchange(aesKey, aesIv, publicKey);
  check(typeof b64 === 'string' && b64.length > 0, 'returns non-empty base64 string');

  const decryptedPlain = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(b64, 'base64'),
  ).toString('utf8');
  const [keyHex, ivHex] = decryptedPlain.split(':');
  check(keyHex === aesKey.toString('hex'), 'roundtrip preserves aesKey hex');
  check(ivHex === aesIv.toString('hex'), 'roundtrip preserves aesIv hex');
});

// --- AES-CBC encrypt/decrypt ----------------------------------------------
test('AES-CBC roundtrip with various plaintext lengths', () => {
  const { aesKey, aesIv } = c.generateAesSessionKey();
  for (const text of [
    'short',
    'exactly_16_bytes',   // 16 chars — boundary case, no padding needed
    'a longer payload that exceeds one block of AES',
    'salt/abcd1234/jdev/sys/getkey2/admin',
  ]) {
    const ct = c.aesEncrypt(text, aesKey, aesIv);
    check(ct.length % 16 === 0, `ciphertext length is block-aligned for "${text}"`);
    const back = c.aesDecrypt(ct, aesKey, aesIv);
    check(back === text, `roundtrip "${text}"`, `got "${back}"`);
  }
});

// --- Encrypted-command builder --------------------------------------------
test('buildEncryptedCommand emits prefix + URI-encoded base64', () => {
  const { aesKey, aesIv } = c.generateAesSessionKey();
  const out = c.buildEncryptedCommand({
    cmd: 'jdev/sys/getkey2/admin',
    salt: 'abcd1234',
    aesKey, aesIv,
  });
  check(out.startsWith('jdev/sys/fenc/'), 'starts with fenc prefix');
  check(!out.includes('/jdev/sys/fenc/jdev'), 'inner cmd is encrypted, not visible');
  // Decode and verify roundtrip
  const payload = decodeURIComponent(out.slice('jdev/sys/fenc/'.length));
  const ct = Buffer.from(payload, 'base64');
  const plain = c.aesDecrypt(ct, aesKey, aesIv);
  check(plain === 'salt/abcd1234/jdev/sys/getkey2/admin', 'inner plaintext is salt/<salt>/<cmd>');
});

test('buildEncryptedCommandWithSaltRotation uses nextSalt form', () => {
  const { aesKey, aesIv } = c.generateAesSessionKey();
  const out = c.buildEncryptedCommandWithSaltRotation({
    cmd: 'jdev/sys/getkey2/admin',
    prevSalt: 'aaaaaaaa', nextSalt: 'bbbbbbbb',
    aesKey, aesIv,
  });
  const payload = decodeURIComponent(out.slice('jdev/sys/fenc/'.length));
  const ct = Buffer.from(payload, 'base64');
  const plain = c.aesDecrypt(ct, aesKey, aesIv);
  check(plain === 'nextSalt/aaaaaaaa/bbbbbbbb/jdev/sys/getkey2/admin', 'inner plaintext is nextSalt/<prev>/<next>/<cmd>');
});

// --- Password hash + HMAC --------------------------------------------------
test('passwordHash uppercase HASH("password:userSalt")', () => {
  // Compute expected manually for SHA256.
  const expectedSha256 = crypto.createHash('sha256').update('Secret123:F0F1F2F3').digest('hex').toUpperCase();
  check(c.passwordHash('Secret123', 'F0F1F2F3', 'SHA256') === expectedSha256, 'SHA256 case');

  const expectedSha1 = crypto.createHash('sha1').update('Secret123:F0F1F2F3').digest('hex').toUpperCase();
  check(c.passwordHash('Secret123', 'F0F1F2F3', 'SHA1') === expectedSha1, 'SHA1 case');
});

test('userHmac uses key bytes (hex-decoded) + "user:pwHash"', () => {
  const key = 'deadbeefcafebabe';
  const user = 'admin';
  const pwHash = '0123456789ABCDEF';
  const expected = crypto.createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${user}:${pwHash}`).digest('hex');
  check(c.userHmac(key, user, pwHash, 'SHA256') === expected, 'SHA256 HMAC matches manual compute');
});

test('rejects unknown hashAlg loudly', () => {
  let threw = false;
  try { c.passwordHash('x', 'y', 'MD5'); } catch { threw = true; }
  check(threw, 'passwordHash throws on MD5');

  threw = false;
  try { c.userHmac('abcd', 'u', 'h', 'SHA512'); } catch { threw = true; }
  check(threw, 'userHmac throws on SHA512');
});

test('generateSalt produces 8-char hex strings', () => {
  const s1 = c.generateSalt();
  const s2 = c.generateSalt();
  check(/^[0-9a-f]{8}$/.test(s1), `salt is 8 hex chars: ${s1}`);
  check(s1 !== s2, 'consecutive salts differ');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
