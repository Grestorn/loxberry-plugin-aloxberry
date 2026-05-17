'use strict';

// HMAC verification for inbound bridge directives.
//
// Wire contract (matches aws/lambda/shared/src/hmac.js):
//   - Headers are carried inside the WSS `directive` envelope's `headers` field:
//       msg.headers['x-aloxberry-timestamp']   Unix ms as decimal string
//       msg.headers['x-aloxberry-signature']   hex(HMAC-SHA256(key, signingString))
//   - signingString = `${timestamp}\n${JSON.stringify(directive)}`
//   - key = skillSecret raw bytes (the daemon holds this from BRIDGE_CONNECTION_CREDENTIAL;
//          the Lambda holds the same 32 bytes — stored as hex in DDB — and decodes
//          before signing)
//
// Why verify on the daemon at all? The bridge is a dumb router — it
// authenticates only the *Lambda* (via its env-var dispatch secret) but
// cannot prove a directive originated from a Lambda the user actually
// authorized. A compromised bridge could otherwise replay/forge directives
// to anyone's plugin. End-to-end HMAC keeps the trust boundary at the user's
// own credential pair.

const crypto = require('node:crypto');

const HEADER_TIMESTAMP = 'x-aloxberry-timestamp';
const HEADER_SIGNATURE = 'x-aloxberry-signature';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

class VerifyError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'VerifyError';
    this.reason = reason; // short machine-readable code, safe for logging
  }
}

function buildSigningString(timestamp, body) {
  return `${timestamp}\n${body || ''}`;
}

// Verify a directive envelope.
//
// Inputs:
//   directive      — the parsed Alexa directive object (same JSON the Lambda signed)
//   headers        — case-insensitive map of header key → value
//   skillSecret    — Buffer of 32 raw bytes
//   now (optional) — ms since epoch, defaults to Date.now() (used by tests)
//
// Returns: { ok: true } on success.
// Throws VerifyError otherwise — reason is one of:
//   'missing_header' | 'bad_timestamp' | 'expired' | 'bad_signature_hex' |
//   'signature_mismatch' | 'no_secret'
function verifyDirective({ directive, headers, skillSecret, now = Date.now() }) {
  if (!skillSecret || skillSecret.length === 0) {
    throw new VerifyError('no_secret', 'daemon has no skillSecret loaded');
  }
  const h = lowerCaseHeaders(headers);
  const timestamp = h[HEADER_TIMESTAMP];
  const signature = h[HEADER_SIGNATURE];
  if (!timestamp || !signature) {
    throw new VerifyError('missing_header', `expected ${HEADER_TIMESTAMP} and ${HEADER_SIGNATURE}`);
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new VerifyError('bad_timestamp', `not a number: ${timestamp}`);
  }
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
    throw new VerifyError('expired',
      `timestamp drift ${Math.abs(now - ts)}ms exceeds ${MAX_CLOCK_SKEW_MS}ms`);
  }

  // Re-stringify the directive deterministically. JSON.stringify is stable
  // for object key order *as inserted* — the bridge passes the directive
  // through verbatim from the Lambda's JSON.parse, so key order is preserved.
  const body = JSON.stringify(directive);
  const expected = crypto.createHmac('sha256', skillSecret)
    .update(buildSigningString(ts, body), 'utf8')
    .digest();

  let provided;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    throw new VerifyError('bad_signature_hex', 'signature is not valid hex');
  }
  if (provided.length !== expected.length) {
    throw new VerifyError('signature_mismatch', 'signature length differs');
  }
  if (!crypto.timingSafeEqual(provided, expected)) {
    throw new VerifyError('signature_mismatch', 'signature does not match');
  }
  return { ok: true };
}

function lowerCaseHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const k of Object.keys(headers)) out[k.toLowerCase()] = headers[k];
  return out;
}

module.exports = {
  verifyDirective,
  VerifyError,
  HEADER_TIMESTAMP,
  HEADER_SIGNATURE,
  MAX_CLOCK_SKEW_MS,
};
