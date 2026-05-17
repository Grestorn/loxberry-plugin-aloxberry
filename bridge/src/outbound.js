'use strict';

// Outbound: forward daemon-originated `report` frames to the Lambda's
// /event endpoint. Bridge does no inspection of the inner payload — the
// daemon signed it with the per-pairing skillSecret, and only the Lambda
// (which has DDB access to that secret) can verify.
//
// Two auth headers on the outbound POST:
//
//   X-Bridge-Auth        — BRIDGE_DISPATCH_SECRET (same value as inbound
//                          /dispatch). Tells the Lambda this came from
//                          our bridge, not a forged third-party POST.
//
//   X-Aloxberry-Timestamp  — the daemon's HMAC timestamp + signature over
//   X-Aloxberry-Signature    the canonical payload body. End-to-end auth
//                          between daemon and Lambda.
//
// Fire-and-forget by design: state-change events are self-resetting (the
// next transition overwrites a missed one), and stalling the WS handler
// on an HTTP round-trip would hold up the daemon's other frames.

const LAMBDA_EVENT_URL = process.env.LAMBDA_EVENT_URL || '';
const BRIDGE_DISPATCH_SECRET = process.env.BRIDGE_DISPATCH_SECRET || '';

const FORWARD_TIMEOUT_MS = 5000;

async function forwardReport({ timestamp, signature, payload, log }) {
  if (!LAMBDA_EVENT_URL) {
    log.warn('LAMBDA_EVENT_URL not set — dropping report');
    return { ok: false, reason: 'no_lambda_url' };
  }
  if (!BRIDGE_DISPATCH_SECRET) {
    log.warn('BRIDGE_DISPATCH_SECRET not set — dropping report');
    return { ok: false, reason: 'no_dispatch_secret' };
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    log.warn('forwardReport: payload missing');
    return { ok: false, reason: 'no_payload' };
  }

  try {
    const res = await fetch(LAMBDA_EVENT_URL, {
      method: 'POST',
      headers: {
        'content-type':         'application/json',
        'x-bridge-auth':        BRIDGE_DISPATCH_SECRET,
        'x-aloxberry-timestamp':  String(timestamp),
        'x-aloxberry-signature':  String(signature),
      },
      body:   payload,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, body: text.slice(0, 200) }, 'lambda /event returned non-2xx');
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    log.warn({ err: err.message }, 'forwardReport failed');
    return { ok: false, reason: 'fetch_failed' };
  }
}

module.exports = { forwardReport };
