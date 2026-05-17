'use strict';

const { createHmac, timingSafeEqual } = require('crypto');

// Header conventions for HMAC-signed requests. Two flavours exist:
//
//   x-alexa-*    — LEGACY direct path (Lambda → plugin /alexa/directive).
//                  Kept because the OAuth handler's /alexa/ping probe still
//                  uses this convention. Will retire when the OAuth flow
//                  switches over to the bridge-style /probe in step 7c.
//
//   x-aloxberry-*  — bridge path. End-to-end HMAC between Lambda and the
//                  daemon, with the bridge as an opaque router. Signed with
//                  the per-user `skillSecret` (32 random bytes).
//
// Both flavours use the same signing string: `${timestamp}\n${body}`.
// Both reject timestamps that drift more than ±5 min from the verifier's clock.
const HEADER_TIMESTAMP = 'x-alexa-timestamp';
const HEADER_SIGNATURE = 'x-alexa-signature';
const HEADER_ALOXBERRY_TIMESTAMP = 'x-aloxberry-timestamp';
const HEADER_ALOXBERRY_SIGNATURE = 'x-aloxberry-signature';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function buildSigningString(timestamp, body) {
  return `${timestamp}\n${body || ''}`;
}

function signRequest({ secret, body, timestamp = Date.now() }) {
  if (!secret) throw new Error('signRequest: secret is required');
  const sig = createHmac('sha256', secret)
    .update(buildSigningString(timestamp, body))
    .digest('hex');
  return {
    [HEADER_TIMESTAMP]: String(timestamp),
    [HEADER_SIGNATURE]: sig,
  };
}

// Bridge-flavoured signing: same algorithm, different header names so the
// daemon (which never sees alexa-prefixed traffic) can distinguish bridge
// traffic from any future direct-mode fallback we might add.
function signAloxberryRequest({ secret, body, timestamp = Date.now() }) {
  if (!secret) throw new Error('signAloxberryRequest: secret is required');
  const sig = createHmac('sha256', secret)
    .update(buildSigningString(timestamp, body))
    .digest('hex');
  return {
    [HEADER_ALOXBERRY_TIMESTAMP]: String(timestamp),
    [HEADER_ALOXBERRY_SIGNATURE]: sig,
  };
}

function verifyRequest({ secret, body, timestamp, signature, now = Date.now() }) {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return false;

  const expected = createHmac('sha256', secret)
    .update(buildSigningString(ts, body))
    .digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

module.exports = {
  HEADER_TIMESTAMP,
  HEADER_SIGNATURE,
  HEADER_ALOXBERRY_TIMESTAMP,
  HEADER_ALOXBERRY_SIGNATURE,
  MAX_CLOCK_SKEW_MS,
  signRequest,
  signAloxberryRequest,
  verifyRequest,
};
