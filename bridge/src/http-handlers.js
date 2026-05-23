'use strict';

const crypto = require('crypto');

const routing = require('./routing');
const dispatch = require('./dispatch');
const pair = require('./pair');
const notify = require('./notify');

// HTTP route handlers.
//
//   GET  /health    → implemented
//   POST /dispatch  → implemented (this step)
//   GET  /probe     → stub; step 4
//
// /dispatch is the only Lambda → bridge call. The bridge is the trust
// boundary: env-var secret authenticates the request, then the bridge
// forwards the (already HMAC-signed) directive to the plugin's WSS and
// awaits a matching response. End-to-end auth between Lambda and plugin
// makes this layer not need to understand directive contents.

const BRIDGE_DISPATCH_SECRET = process.env.BRIDGE_DISPATCH_SECRET || '';

const DISPATCH_TIMEOUT_MS = Number.parseInt(process.env.DISPATCH_TIMEOUT_MS, 10) || 10000;

// Alexa Smart Home directives are typically well under 8 KB. 256 KB leaves
// generous headroom for future directive shapes without inviting abuse.
const MAX_DISPATCH_BODY_BYTES = 256 * 1024;

// Same userId shape as the WSS handshake. Duplicated rather than imported
// from ws-handlers.js because it's a one-line wire constant — extracting a
// shared module for a single regex is premature.
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// ----- helpers ---------------------------------------------------------------

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res) {
  writeJson(res, 404, { error: 'not_found' });
}

function methodNotAllowed(res, allowed) {
  res.writeHead(405, {
    'Content-Type': 'application/json',
    Allow: allowed,
  });
  res.end(JSON.stringify({ error: 'method_not_allowed', allowed }));
}

// Constant-time secret compare. Returns false (and never throws) for length
// mismatches; the length check is not itself a leak — the header's length
// is observable already from the request bytes.
function authMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return crypto.timingSafeEqual(a, b);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    // Reject early if Content-Length declares an oversize body. Some clients
    // might still send unannounced bodies (chunked), so the per-chunk check
    // below is the real enforcement.
    const declared = Number.parseInt(req.headers['content-length'], 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new Error('payload_too_large'));
      req.resume(); // drain so the connection can be reused
      return;
    }

    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.length === 0 ? null : JSON.parse(text));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

// ----- handlers --------------------------------------------------------------

const startedAt = Date.now();

function handleHealth(res) {
  writeJson(res, 200, {
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    connections: routing.size(),
    pendingDispatches: dispatch.size(),
    pendingPairs: pair.size(),
  });
}

async function handleDispatch(req, res, log) {
  // 0. Server must be configured. Failing here (rather than passing a
  //    half-secured bridge) is intentional — operators should see this loudly.
  if (!BRIDGE_DISPATCH_SECRET) {
    log.error('/dispatch called but BRIDGE_DISPATCH_SECRET is unset');
    return writeJson(res, 503, { error: 'not_configured' });
  }

  // 1. Auth.
  const auth = req.headers['x-bridge-auth'];
  if (!authMatches(auth, BRIDGE_DISPATCH_SECRET)) {
    return writeJson(res, 401, { error: 'unauthorized' });
  }

  // 2. Parse body.
  let body;
  try {
    body = await readJsonBody(req, MAX_DISPATCH_BODY_BYTES);
  } catch (err) {
    return writeJson(res, 400, { error: err.message });
  }
  if (!body || typeof body !== 'object') {
    return writeJson(res, 400, { error: 'invalid_body' });
  }

  // 3. Validate shape.
  if (typeof body.userId !== 'string' || !USER_ID_PATTERN.test(body.userId)) {
    return writeJson(res, 400, { error: 'invalid_userId' });
  }
  if (!body.directive || typeof body.directive !== 'object') {
    return writeJson(res, 400, { error: 'invalid_directive' });
  }
  if (!body.headers || typeof body.headers !== 'object') {
    return writeJson(res, 400, { error: 'invalid_headers' });
  }

  // 4. Find the plugin's socket.
  const ws = routing.get(body.userId);
  if (!ws || ws.readyState !== ws.OPEN) {
    log.info({ userId: body.userId }, '/dispatch: plugin offline');
    return writeJson(res, 504, { error: 'offline' });
  }

  // 5. Correlate + forward.
  const requestId = crypto.randomUUID();
  const responsePromise = dispatch.register(requestId, body.userId, DISPATCH_TIMEOUT_MS);

  try {
    ws.send(JSON.stringify({
      type: 'directive',
      requestId,
      directive: body.directive,
      headers: body.headers,
    }));
  } catch (err) {
    log.warn({ userId: body.userId, err: err.message }, '/dispatch: send failed');
    // Cancel the awaiter we just registered so it doesn't leak until timeout.
    dispatch.rejectAllForUser(body.userId, 'send_failed');
    return writeJson(res, 504, { error: 'send_failed' });
  }

  // 6. Wait.
  try {
    const response = await responsePromise;
    return writeJson(res, 200, response ?? {});
  } catch (err) {
    const reason = err.message || 'dispatch_error';
    log.info({ userId: body.userId, requestId, reason }, '/dispatch: failed');
    if (reason === 'dispatch_timeout') {
      return writeJson(res, 504, { error: 'timeout' });
    }
    if (reason === 'plugin_disconnected' || reason === 'send_failed') {
      return writeJson(res, 504, { error: 'offline' });
    }
    return writeJson(res, 504, { error: reason });
  }
}

// One-shot read of a pair-code entry published by a daemon over WSS.
//   Auth: X-Bridge-Auth (same shared secret as /dispatch)
//   Query: code=<10 chars [A-Z2-9]>
//   Success: 200 { userId, skillSecret }   ← entry is deleted on read
//   404: code is unknown or already consumed or expired
function handlePair(req, res, log) {
  if (!BRIDGE_DISPATCH_SECRET) {
    log.error('/pair called but BRIDGE_DISPATCH_SECRET is unset');
    return writeJson(res, 503, { error: 'not_configured' });
  }
  if (!authMatches(req.headers['x-bridge-auth'], BRIDGE_DISPATCH_SECRET)) {
    return writeJson(res, 401, { error: 'unauthorized' });
  }

  const queryStart = req.url.indexOf('?');
  const params = queryStart >= 0
    ? new URLSearchParams(req.url.slice(queryStart + 1))
    : new URLSearchParams();
  const code = params.get('code');
  if (!code) {
    return writeJson(res, 400, { error: 'missing_code' });
  }
  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) {
    // Shape-check before peeking. Prevents probing a misformed value from
    // touching the Map at all.
    return writeJson(res, 400, { error: 'invalid_code' });
  }

  const entry = pair.take(code);
  if (!entry) {
    log.info({ codePrefix: code.slice(0, 2) }, '/pair: code not found or expired');
    return writeJson(res, 404, { error: 'not_found' });
  }
  log.info(
    { codePrefix: code.slice(0, 2), userId: entry.userId, pairTableSize: pair.size() },
    '/pair: code consumed',
  );
  return writeJson(res, 200, entry);
}

// Lambda → bridge: push a notification frame to a connected daemon. Same
// auth shape as /dispatch (X-Bridge-Auth shared secret). Fire-and-forget —
// the daemon refetches its current health on the next welcome, so a missed
// notification is self-healing. Always returns 200 with an `ok` flag so
// the caller (Lambda) doesn't have to distinguish "daemon offline" from
// "delivered" for retry purposes.
async function handleNotify(req, res, log) {
  if (!BRIDGE_DISPATCH_SECRET) {
    log.error('/notify called but BRIDGE_DISPATCH_SECRET is unset');
    return writeJson(res, 503, { error: 'not_configured' });
  }
  if (!authMatches(req.headers['x-bridge-auth'], BRIDGE_DISPATCH_SECRET)) {
    return writeJson(res, 401, { error: 'unauthorized' });
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_DISPATCH_BODY_BYTES);
  } catch (err) {
    return writeJson(res, 400, { error: err.message });
  }
  if (!body || typeof body !== 'object') {
    return writeJson(res, 400, { error: 'invalid_body' });
  }
  if (typeof body.userId !== 'string' || !USER_ID_PATTERN.test(body.userId)) {
    return writeJson(res, 400, { error: 'invalid_userId' });
  }
  if (!body.notification || typeof body.notification !== 'object') {
    return writeJson(res, 400, { error: 'invalid_notification' });
  }

  const result = notify.deliver(body.userId, body.notification);
  if (result.ok) {
    log.info({ kind: body.notification.kind }, 'notify delivered');
    return writeJson(res, 200, { ok: true });
  }
  log.info({ kind: body.notification.kind, reason: result.reason }, 'notify dropped — daemon offline');
  return writeJson(res, 200, { ok: false, reason: result.reason });
}

function handleProbe(req, res, log) {
  if (!BRIDGE_DISPATCH_SECRET) {
    log.error('/probe called but BRIDGE_DISPATCH_SECRET is unset');
    return writeJson(res, 503, { error: 'not_configured' });
  }
  if (!authMatches(req.headers['x-bridge-auth'], BRIDGE_DISPATCH_SECRET)) {
    return writeJson(res, 401, { error: 'unauthorized' });
  }

  const queryStart = req.url.indexOf('?');
  const params = queryStart >= 0
    ? new URLSearchParams(req.url.slice(queryStart + 1))
    : new URLSearchParams();
  const userId = params.get('userId');
  if (!userId) {
    return writeJson(res, 400, { error: 'missing_userId' });
  }
  if (!USER_ID_PATTERN.test(userId)) {
    return writeJson(res, 400, { error: 'invalid_userId' });
  }

  // Double-check the socket is actually open. The routing map should never
  // hold a closed socket (close handler removes it), but there's a brief
  // window between TCP teardown and the close event firing where it might.
  const ws = routing.get(userId);
  const connected = !!(ws && ws.readyState === ws.OPEN);
  return writeJson(res, 200, { connected });
}

function handleRequest(req, res, log) {
  const { method, url } = req;
  const path = url.split('?', 1)[0];

  if (path === '/health') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    return handleHealth(res);
  }

  if (path === '/dispatch') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    return handleDispatch(req, res, log).catch((err) => {
      // Defensive last-resort. Any synchronous throw above already gets
      // swallowed by the async wrapper; this catches anything we missed.
      log.error({ err: err.message }, '/dispatch: unexpected error');
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal' });
      }
    });
  }

  if (path === '/notify') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    return handleNotify(req, res, log).catch((err) => {
      log.error({ err: err.message }, '/notify: unexpected error');
      if (!res.headersSent) writeJson(res, 500, { error: 'internal' });
    });
  }

  if (path === '/probe') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    return handleProbe(req, res, log);
  }

  if (path === '/pair') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    return handlePair(req, res, log);
  }

  return notFound(res);
}

module.exports = {
  handleRequest,
};
