'use strict';

// Crypto primitives for talking to a Loxone Miniserver.
//
// Three layers, all required even on WSS:
//   1. RSA-PKCS1-v1.5 for the one-time AES key exchange
//   2. AES-256-CBC (zero-byte padded) for every subsequent command
//   3. HMAC + SHA hash family for password proof
//
// All routines use Node's built-in `crypto`; no external deps. Test
// vectors live in test-miniserver-crypto.cjs.
//
// Sources / references:
//   - websocket-flow.md  (this repo's loxberry-miniserver-comms skill)
//   - "Communicating with the Miniserver" v17 PDF, pp.14-15 (encryption)
//     and pp.26-27 (token acquisition).
//   - Reference impls: node-lox-ws-api, PyLoxone.

const crypto = require('node:crypto');

// --- AES key + IV generation ----------------------------------------------

// 32-byte key, 16-byte IV. Both are random per WS session and never reused.
function generateAesSessionKey() {
  return {
    aesKey: crypto.randomBytes(32),
    aesIv: crypto.randomBytes(16),
  };
}

// --- RSA-PKCS1-v1.5 encryption --------------------------------------------

// Encrypt the AES session key for transmission to the Miniserver.
// Loxone expects the plaintext "<aesKeyHex>:<aesIvHex>" (lowercase hex,
// colon-separated) wrapped by PKCS1-v1.5 padding and base64-encoded.
function rsaEncryptKeyExchange(aesKey, aesIv, publicKey) {
  const plaintext = `${aesKey.toString('hex')}:${aesIv.toString('hex')}`;
  const ciphertext = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, 'utf8'),
  );
  return ciphertext.toString('base64');
}

// --- AES-256-CBC with zero-byte padding -----------------------------------

// Loxone uses zero-byte padding (NOT PKCS#7). Node's default cipher would
// add PKCS#7 padding, so we disable autopad and align the plaintext to a
// 16-byte boundary ourselves.
//
// Zero-byte padding ambiguity (if plaintext ends in 0x00) doesn't matter
// here — all Loxone commands are ASCII text.
function aesEncrypt(plaintext, aesKey, aesIv) {
  const buf = Buffer.from(plaintext, 'utf8');
  const padLen = 16 - (buf.length % 16); // 16 → 16 (always at least one byte of pad? no, 16 means no pad needed)
  // Strictly: if buf.length is a multiple of 16, we don't need to pad —
  // the cipher accepts exact-block input. Add pad only if needed.
  const padded = buf.length % 16 === 0
    ? buf
    : Buffer.concat([buf, Buffer.alloc(padLen, 0)]);

  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesIv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function aesDecrypt(ciphertext, aesKey, aesIv) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesIv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Strip trailing zero bytes. Loxone responses are JSON text, so any
  // 0x00 byte at the end is padding.
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  return plain.subarray(0, end).toString('utf8');
}

// --- Encrypted-command builder --------------------------------------------

// Wrap a plain command in the salt-prefixed AES envelope and produce the
// URL-suffix the Miniserver expects:
//
//   plaintext   = "salt/<salt>/<cmd>"           (or nextSalt form)
//   ciphertext  = aesEncrypt(plaintext)         → bytes
//   payload     = base64(ciphertext)            → ASCII
//   urlPart     = encodeURIComponent(payload)   → URL-safe
//   full        = "jdev/sys/enc/<urlPart>"      (or .../fenc/...)
//
// `fenc` asks the MS to encrypt its response. Use it for getkey2/getjwt;
// `enc` is fine for fire-and-forget like enablebinstatusupdate.
function buildEncryptedCommand({ cmd, salt, aesKey, aesIv, encryptResponse = true }) {
  const plaintext = `salt/${salt}/${cmd}`;
  const ciphertext = aesEncrypt(plaintext, aesKey, aesIv);
  const payload = ciphertext.toString('base64');
  const urlPart = encodeURIComponent(payload);
  const prefix = encryptResponse ? 'jdev/sys/fenc' : 'jdev/sys/enc';
  return `${prefix}/${urlPart}`;
}

// nextSalt form — used when rotating the salt.
function buildEncryptedCommandWithSaltRotation({
  cmd, prevSalt, nextSalt, aesKey, aesIv, encryptResponse = true,
}) {
  const plaintext = `nextSalt/${prevSalt}/${nextSalt}/${cmd}`;
  const ciphertext = aesEncrypt(plaintext, aesKey, aesIv);
  const payload = ciphertext.toString('base64');
  const urlPart = encodeURIComponent(payload);
  const prefix = encryptResponse ? 'jdev/sys/fenc' : 'jdev/sys/enc';
  return `${prefix}/${urlPart}`;
}

// --- Password hashing -----------------------------------------------------

// Phase 6 of the handshake:
//   pwHash = uppercase( HASH("<password>:<userSalt>") )
//   hash   = HMAC( key, "<user>:<pwHash>" )
//
// HASH is SHA1 or SHA256, chosen from getkey2's `hashAlg` field. We never
// hardcode it — the Miniserver tells us which family to use.
function passwordHash(password, userSalt, hashAlg) {
  const algo = normaliseHashAlg(hashAlg);
  // PyLoxone uses the salt string verbatim from the getkey2 response.
  // Match that — our earlier hex→ASCII conversion experiment didn't help.
  return crypto.createHash(algo)
    .update(`${password}:${userSalt}`, 'utf8')
    .digest('hex')
    .toUpperCase();
}

// HMAC of an arbitrary token (or any plaintext) with the key from getkey2.
// Used by authwithtoken (HMAC(key, token)) and refreshjwt (HMAC(key, token)).
function tokenHmac(key, token, hashAlg) {
  const algo = normaliseHashAlg(hashAlg);
  const keyBytes = Buffer.from(key, 'hex');
  return crypto.createHmac(algo, keyBytes)
    .update(token, 'utf8')
    .digest('hex');
}

function userHmac(key, user, pwHash, hashAlg) {
  const algo = normaliseHashAlg(hashAlg);
  // PyLoxone uses `bytes.fromhex(key)` — i.e. hex-decoded raw bytes as the
  // HMAC key. We do the same. (node-lox-ws-api does .toString('utf8') after
  // hex-decoding, but that's the legacy `gettoken` flow, not getjwt.)
  const keyBytes = Buffer.from(key, 'hex');
  return crypto.createHmac(algo, keyBytes)
    .update(`${user}:${pwHash}`, 'utf8')
    .digest('hex');
}

function normaliseHashAlg(hashAlg) {
  switch ((hashAlg || '').toUpperCase()) {
    case 'SHA1':   return 'sha1';
    case 'SHA256': return 'sha256';
    default:
      throw new Error(`unsupported hashAlg from getkey2: ${hashAlg}`);
  }
}

// --- Salt management ------------------------------------------------------

// Spec just says "hex string, ~2 bytes is fine". Use 4 bytes (8 hex chars)
// for some extra safety margin against accidental collision across reuses.
function generateSalt() {
  return crypto.randomBytes(4).toString('hex');
}

module.exports = {
  generateAesSessionKey,
  rsaEncryptKeyExchange,
  aesEncrypt,
  aesDecrypt,
  buildEncryptedCommand,
  buildEncryptedCommandWithSaltRotation,
  passwordHash,
  userHmac,
  tokenHmac,
  generateSalt,
};
