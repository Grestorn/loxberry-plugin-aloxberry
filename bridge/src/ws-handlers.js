'use strict';

const { createHash } = require('crypto');

const routing = require('./routing');
const dispatch = require('./dispatch');
const pair = require('./pair');
const outbound = require('./outbound');

// userId is a routing/identity token whose secrecy the anti-hijack
// protection depends on — never log it raw (P0 #5 / #13). A short,
// non-reversible fingerprint still lets an operator correlate the log
// lines for one plugin.
function fp(userId) {
  if (typeof userId !== 'string' || userId.length === 0) return '-';
  return createHash('sha256').update(userId).digest('hex').slice(0, 8);
}

// WSS /connect lifecycle.
//
// Wire protocol v1 (see bridge/README.md for the full table):
//   Plugin → bridge (first msg):  { type:"hello",    userId, version:1 }
//   Bridge → plugin (ack):        { type:"welcome",  version:1 }
//   Bridge → plugin (heartbeat):  { type:"ping" }
//   Plugin → bridge (heartbeat):  { type:"pong" }
//   Plugin → bridge (dispatch):   { type:"response", requestId, response }
//
// Close-code vocabulary:
//   4002  protocol error (bad json, bad shape, bad version, bad userId, duplicate hello)
//   4003  replaced (a newer connection took this userId; do not retry-storm — reconnect once)
//   4004  heartbeat timeout (no pong within window; reconnect with backoff)
//   4005  hello timeout (no handshake within window; usually a misbehaving client)
//
// Timers are tunable via env so smoke tests can run fast. Defaults assume a
// generous keepalive window — many intermediaries (Caddy, Cloudflare) cap
// idle WS at 60–120s, so 30s pings comfortably stay under that.

const PROTOCOL_VERSION = 1;

// 16 random bytes encoded base64url = exactly 22 chars in [A-Za-z0-9_-].
// The plugin generates this on first install (see project memory:
// project_bridge_architecture.md).
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const HELLO_TIMEOUT_MS = Number.parseInt(process.env.HELLO_TIMEOUT_MS, 10) || 5000;
const HEARTBEAT_INTERVAL_MS = Number.parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10) || 30000;
const PONG_TIMEOUT_MS = Number.parseInt(process.env.PONG_TIMEOUT_MS, 10) || 60000;

const CLOSE = {
  PROTOCOL_ERROR: 4002,
  REPLACED: 4003,
  HEARTBEAT_TIMEOUT: 4004,
  HELLO_TIMEOUT: 4005,
  // A live connection already owns this userId; the newcomer is refused
  // rather than allowed to displace it (anti-hijack). A genuine plugin
  // reconnecting after its old socket died will be accepted once that
  // socket is detected closed/stale — its backoff loop covers the gap.
  SLOT_IN_USE: 4006,
};

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // Send failures usually mean the socket is mid-close; the 'close'
    // handler will run shortly and clean up. Nothing else to do.
  }
}

function safeClose(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    // ditto
  }
}

function handleConnection(ws, _req, log) {
  const state = {
    userId: null,
    helloTimer: null,
    heartbeatTimer: null,
    pongDeadlineTimer: null,
  };

  function clearTimers() {
    if (state.helloTimer) clearTimeout(state.helloTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.pongDeadlineTimer) clearTimeout(state.pongDeadlineTimer);
    state.helloTimer = null;
    state.heartbeatTimer = null;
    state.pongDeadlineTimer = null;
  }

  function sendPing() {
    safeSend(ws, { type: 'ping' });
    // Arm a single pong deadline; subsequent pings reuse it. A pong cancels
    // the deadline. Only "no pong at all within PONG_TIMEOUT_MS of the first
    // un-acknowledged ping" triggers a close.
    if (!state.pongDeadlineTimer) {
      state.pongDeadlineTimer = setTimeout(() => {
        log.warn({ uid: fp(state.userId) }, 'heartbeat timeout');
        safeClose(ws, CLOSE.HEARTBEAT_TIMEOUT, 'heartbeat timeout');
      }, PONG_TIMEOUT_MS);
    }
  }

  function notePong() {
    if (state.pongDeadlineTimer) {
      clearTimeout(state.pongDeadlineTimer);
      state.pongDeadlineTimer = null;
    }
  }

  // Until the hello arrives we know nothing about who's connecting; if it
  // never arrives, drop the socket so we don't leak half-open sessions.
  state.helloTimer = setTimeout(() => {
    log.warn('hello timeout');
    safeClose(ws, CLOSE.HELLO_TIMEOUT, 'hello timeout');
  }, HELLO_TIMEOUT_MS);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      log.warn({ uid: fp(state.userId) }, 'invalid json from client');
      return safeClose(ws, CLOSE.PROTOCOL_ERROR, 'invalid json');
    }
    if (!msg || typeof msg.type !== 'string') {
      log.warn({ uid: fp(state.userId) }, 'malformed message');
      return safeClose(ws, CLOSE.PROTOCOL_ERROR, 'malformed message');
    }

    if (state.userId === null) {
      // Pre-handshake: the *only* acceptable message is a well-formed hello.
      if (msg.type !== 'hello') {
        log.warn({ type: msg.type }, 'expected hello');
        return safeClose(ws, CLOSE.PROTOCOL_ERROR, 'expected hello');
      }
      if (msg.version !== PROTOCOL_VERSION) {
        log.warn({ version: msg.version }, 'unsupported protocol version');
        return safeClose(ws, CLOSE.PROTOCOL_ERROR, 'unsupported version');
      }
      if (typeof msg.userId !== 'string' || !USER_ID_PATTERN.test(msg.userId)) {
        log.warn({ uid: fp(msg.userId) }, 'invalid userId');
        return safeClose(ws, CLOSE.PROTOCOL_ERROR, 'invalid userId');
      }

      // Anti-hijack: a newcomer may take a userId slot only if it's free,
      // or the prior socket is closed/stale. A provably-live prior socket
      // is NOT displaced — refuse the newcomer instead. state.userId is
      // left null on rejection so the close handler treats it as a
      // never-registered socket (clean no-op, no dispatch rejection).
      const decision = routing.tryAdd(msg.userId, ws);
      if (decision.action === 'rejected') {
        log.warn({ uid: fp(msg.userId) },
          'hello refused — a live connection already owns this userId');
        return safeClose(ws, CLOSE.SLOT_IN_USE, 'slot in use by a live connection');
      }
      clearTimeout(state.helloTimer);
      state.helloTimer = null;
      state.userId = msg.userId;

      if (decision.action === 'displaced' && decision.old) {
        log.info({ uid: fp(state.userId) }, 'replacing dead/stale connection');
        safeClose(decision.old, CLOSE.REPLACED, 'replaced by newer connection');
      }
      log.info(
        { uid: fp(state.userId), totalConnections: routing.size() },
        'plugin connected',
      );
      safeSend(ws, { type: 'welcome', version: PROTOCOL_VERSION });
      state.heartbeatTimer = setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
      return;
    }

    // Any inbound post-handshake frame is proof this socket is alive —
    // refresh its routing liveness so the anti-hijack staleness check
    // (routing.tryAdd) keeps protecting an actively-used connection.
    routing.touch(state.userId, ws);

    // Post-handshake message routing.
    switch (msg.type) {
      case 'pong':
        notePong();
        break;
      case 'response': {
        if (typeof msg.requestId !== 'string') {
          log.warn({ uid: fp(state.userId) }, 'response without requestId — ignoring');
          break;
        }
        const settled = dispatch.resolve(msg.requestId, msg.response);
        if (!settled) {
          // Late or duplicate response. Not a protocol violation (the
          // dispatch may have timed out and Lambda has already given up).
          log.debug(
            { uid: fp(state.userId), requestId: msg.requestId },
            'response had no awaiter (late or duplicate)',
          );
        }
        break;
      }
      case 'pair-publish': {
        // Daemon is asking the bridge to stash a one-shot {userId, skillSecret}
        // tuple keyed by `code`. The bridge already knows this daemon's
        // userId from the hello — we trust that side and trust the daemon
        // not to spoof OTHER users' codes (it can only publish under its
        // own userId, by design).
        if (typeof msg.code !== 'string' || !/^[A-HJ-NP-Z2-9]{10}$/.test(msg.code)) {
          log.warn({ uid: fp(state.userId) }, 'pair-publish: invalid code');
          safeSend(ws, { type: 'pair-publish-error', requestId: msg.requestId || null, reason: 'invalid_code' });
          break;
        }
        if (typeof msg.skillSecret !== 'string' || !/^[0-9a-f]{64}$/i.test(msg.skillSecret)) {
          log.warn({ uid: fp(state.userId) }, 'pair-publish: invalid skillSecret');
          safeSend(ws, { type: 'pair-publish-error', requestId: msg.requestId || null, reason: 'invalid_skill_secret' });
          break;
        }
        pair.store(msg.code, { userId: state.userId, skillSecret: msg.skillSecret });
        log.info(
          { uid: fp(state.userId), codePrefix: msg.code.slice(0, 2), pairTableSize: pair.size() },
          'pair-publish stored',
        );
        safeSend(ws, { type: 'pair-publish-ok', requestId: msg.requestId || null });
        break;
      }
      case 'report': {
        // Daemon → bridge: proactive ChangeReport for an exposed device's
        // state change. The bridge does not look inside `payload`; the
        // daemon signed it end-to-end against per-pairing skillSecret, and
        // only the Lambda (with DDB access) can verify. Fire-and-forget —
        // we don't ack reports back to the daemon. If forwarding fails,
        // the next state change re-fires.
        if (
          typeof msg.timestamp === 'undefined' ||
          typeof msg.signature !== 'string' ||
          typeof msg.payload !== 'string'
        ) {
          log.warn({ uid: fp(state.userId) }, 'report: malformed envelope — dropping');
          break;
        }
        outbound.forwardReport({
          timestamp: msg.timestamp,
          signature: msg.signature,
          payload:   msg.payload,
          log,
        }).catch((err) => {
          // forwardReport handles its own errors internally; this catch is
          // belt-and-braces against an unexpected throw.
          log.warn({ err: err.message, uid: fp(state.userId) }, 'forwardReport threw');
        });
        break;
      }
      case 'hello':
        log.warn({ uid: fp(state.userId) }, 'duplicate hello');
        safeClose(ws, CLOSE.PROTOCOL_ERROR, 'duplicate hello');
        break;
      default:
        // Forward-compatible: unknown types are logged and ignored, so a
        // newer plugin sending extra message types to an older bridge
        // doesn't get summarily disconnected.
        log.debug({ uid: fp(state.userId), type: msg.type }, 'unknown message type ignored');
    }
  });

  ws.on('close', (code, reason) => {
    clearTimers();
    if (state.userId !== null) {
      // Only remove if we're still the registered socket; if we were
      // displaced by a newer connection, leave the new entry alone.
      const removed = routing.remove(state.userId, ws);
      // Fail-fast any in-flight dispatches for this user. Only do this if we
      // actually owned the routing slot — if we were displaced, the new
      // socket is responsible for serving those dispatches.
      const rejected = removed
        ? dispatch.rejectAllForUser(state.userId, 'plugin_disconnected')
        : 0;
      if (removed) {
        log.info(
          {
            uid: fp(state.userId),
            code,
            reason: reason.toString(),
            totalConnections: routing.size(),
            dispatchesRejected: rejected,
          },
          'plugin disconnected',
        );
      }
    } else {
      log.info(
        { code, reason: reason.toString() },
        'connection closed before handshake',
      );
    }
  });

  ws.on('error', (err) => {
    log.warn({ err: err.message, uid: fp(state.userId) }, 'ws error');
  });
}

module.exports = {
  handleConnection,
  CLOSE,
  PROTOCOL_VERSION,
};
