'use strict';

// Persistent WSS client to the dispatch bridge.
//
// Lifecycle:
//   STOPPED → CONNECTING → CONNECTED → (close) → SCHEDULED_RECONNECT → CONNECTING …
//   start()  initiates the loop; stop() exits it (no reconnect after stop()).
//
// Wire protocol (must match bridge/src/ws-handlers.js):
//   Plugin → bridge:  {type:"hello",    userId, version:1}                 (first msg)
//   Bridge → plugin:  {type:"welcome",  version:1}                         (handshake ack)
//   Bridge → plugin:  {type:"ping"}                                        (heartbeat probe)
//   Plugin → bridge:  {type:"pong"}                                        (heartbeat reply)
//   Bridge → plugin:  {type:"directive", requestId, directive, headers}    (dispatch)
//   Plugin → bridge:  {type:"response",  requestId, response}              (dispatch reply)
//
// Close-code action table (CLOSE_ACTIONS below):
//   1000  normal close            → no reconnect (we asked for it)
//   4002  protocol error          → no reconnect (the same code would hit the same wall)
//   4003  replaced by newer conn  → no reconnect (would just kick the new owner)
//   4004  heartbeat timeout       → reconnect (transient)
//   4005  hello timeout           → reconnect (timing / network)
//   *     anything else (1006, network drop, etc.) → reconnect

const EventEmitter = require('node:events');
const WebSocket = require('ws');

const { verifyDirective, VerifyError } = require('./bridge-hmac');

const PROTOCOL_VERSION = 1;

// HMAC verification is strict by default. Set ALOXBERRY_AUTH_MODE=permissive to
// log signature failures without rejecting the directive — only useful during
// the transition from the pre-bridge legacy test rig to a Lambda that signs
// properly. In permissive mode the daemon still attempts to verify and logs
// the outcome, so misconfigurations are still loud.
const AUTH_MODE = (process.env.ALOXBERRY_AUTH_MODE || 'strict').toLowerCase();

// What to do for each close code. true = reconnect, false = give up.
const CLOSE_ACTIONS = {
  1000: { retry: false, reason: 'normal_close' },
  4002: { retry: false, reason: 'protocol_error' },
  4003: { retry: false, reason: 'replaced' },
  4004: { retry: true, reason: 'heartbeat_timeout' },
  4005: { retry: true, reason: 'hello_timeout' },
};
const DEFAULT_CLOSE_ACTION = { retry: true, reason: 'unexpected_close' };

const WELCOME_TIMEOUT_MS = 10000;

class BridgeClient extends EventEmitter {
  constructor({ config, identity, state, log, directiveHandler, pairings }) {
    super();
    this.config = config;
    // `identity` is the loaded {userId, skillSecret, skillSecretBytes}
    // from src/identity.js. Replaces the old `credential` object that came
    // from the env-var parse.
    this.identity = identity;
    this.state = state;
    this.log = log.child({ component: 'bridge-client' });
    // Optional: async (directive) => responseEnvelope. When unset, falls back
    // to the legacy INTERNAL_ERROR stub that step 2 used to verify the
    // round-trip plumbing. Wired in step 6c to the DirectiveRouter.
    this.directiveHandler = directiveHandler || null;
    // Optional pairings tracker — observes (pairingId, pairingName) per
    // directive so the CGI can list which Alexa accounts are active.
    this.pairings = pairings || null;

    this.wsUrl = buildWsUrl(config.bridgeUrl, '/connect');

    this.ws = null;
    this.stopped = false;
    this.connectedOnce = false;
    this.welcomeTimer = null;
    this.reconnectTimer = null;
    this.currentBackoffMs = config.reconnectInitialMs;
    // One-shot flag set by forceReconnect() so onClose retries even on close
    // codes that the default policy treats as "do not retry" (e.g. 1000).
    this.wantsReconnect = false;
    // Master switch (CGI gatekeeper). Differs from `stopped`: `suspended` is
    // reversible; setEnabled(true) brings the connection back. While
    // suspended, onClose does not reconnect, and scheduleReconnect is a no-op.
    this.suspended = false;

    // Outstanding pair-publish acks. Key = requestId, value = {resolve, reject, timer}.
    // Cleared on disconnect (pending ones reject so callers don't hang forever).
    this.pendingPairPublishes = new Map();
  }

  start() {
    if (this.stopped) {
      throw new Error('start() called on stopped BridgeClient');
    }
    this.log.info({ wsUrl: this.wsUrl }, 'bridge client starting');
    if (this.suspended) {
      this.log.info('bridge client is suspended by master switch — not connecting');
      return;
    }
    this.connect();
  }

  // Master-switch toggle. When false, drops the connection and won't auto-
  // reconnect; when true, brings it back up. Idempotent.
  //
  // This is the reversible sibling of stop(): stop() is for daemon shutdown
  // (no come-back), setEnabled(false) is for user-initiated pause.
  setEnabled(enabled) {
    const wantSuspend = !enabled;
    if (this.stopped || this.suspended === wantSuspend) return;

    this.suspended = wantSuspend;
    // Surface the master-switch state in state.json so the CGI can show
    // a clear "suspended" indicator (otherwise the user would just see
    // "disconnected" without a reason).
    this.state.update({ bridge: { suspended: wantSuspend } })
        .catch(() => { /* logged in StateWriter */ });
    if (wantSuspend) {
      this.log.warn('bridge client suspended (master switch off)');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.welcomeTimer) {
        clearTimeout(this.welcomeTimer);
        this.welcomeTimer = null;
      }
      if (this.ws) {
        try { this.ws.close(1000, 'master switch off'); } catch { /* ignore */ }
      }
      this.state.update({ bridge: { connected: false, lastError: 'suspended (master switch off)' } })
          .catch(() => { /* logged in StateWriter */ });
    } else {
      this.log.info('bridge client resumed (master switch on)');
      this.currentBackoffMs = this.config.reconnectInitialMs;
      if (!this.ws && !this.reconnectTimer) {
        this.connect();
      }
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.welcomeTimer) {
      clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'daemon shutdown');
      } catch {
        // ignore
      }
    }
    await this.state.update({ bridge: { connected: false } });
    this.log.info('bridge client stopped');
  }

  // ----- internals -------------------------------------------------------

  connect() {
    if (this.stopped) return;
    this.log.info({ wsUrl: this.wsUrl }, 'connecting');
    let ws;
    try {
      ws = new WebSocket(this.wsUrl, {
        handshakeTimeout: 10000,
        // Cap incoming frames at the same ceiling the bridge accepts on /dispatch
        // (256 KB). Anything larger is either a misbehaving server or an attack.
        maxPayload: 256 * 1024,
      });
    } catch (err) {
      this.log.error({ err: err.message }, 'failed to construct WebSocket — scheduling reconnect');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => this.onOpen(ws));
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', (code, reason) => this.onClose(code, reason));
    ws.on('error', (err) => this.onError(err));
  }

  onOpen(ws) {
    if (ws !== this.ws) return; // stale
    this.log.info('socket open — sending hello');

    // Send hello immediately. Bridge expects it within HELLO_TIMEOUT_MS
    // (default 5s on the server). Then arm our own welcome timer — if the
    // server doesn't ack within WELCOME_TIMEOUT_MS, something's wrong.
    safeSend(ws, {
      type: 'hello',
      userId: this.identity.userId,
      version: PROTOCOL_VERSION,
    });

    this.welcomeTimer = setTimeout(() => {
      this.log.warn('welcome timeout — closing socket');
      safeClose(ws, 1002, 'no welcome');
    }, WELCOME_TIMEOUT_MS);
  }

  async onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch (err) {
      this.log.warn({ err: err.message }, 'invalid json from bridge');
      return;
    }
    if (!msg || typeof msg.type !== 'string') {
      this.log.warn({ msg }, 'malformed message from bridge');
      return;
    }

    switch (msg.type) {
      case 'welcome':
        await this.onWelcome(msg);
        break;
      case 'ping':
        this.log.debug('ping received → pong');
        safeSend(this.ws, { type: 'pong' });
        break;
      case 'directive':
        await this.onDirective(msg);
        break;
      case 'pair-publish-ok':
        this.resolvePairPublish(msg.requestId, null);
        break;
      case 'pair-publish-error':
        this.resolvePairPublish(msg.requestId, new Error(`pair-publish rejected: ${msg.reason || 'unknown'}`));
        break;
      default:
        this.log.debug({ type: msg.type }, 'ignoring unknown message type');
    }
  }

  async onWelcome(msg) {
    if (this.welcomeTimer) {
      clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
    if (msg.version !== PROTOCOL_VERSION) {
      this.log.warn({ version: msg.version }, 'bridge protocol version mismatch');
      // Don't reconnect — same version will be advertised. Surface and stop.
      this.stopped = true;
      safeClose(this.ws, 1002, 'version mismatch');
      return;
    }
    this.connectedOnce = true;
    this.currentBackoffMs = this.config.reconnectInitialMs;
    await this.state.update({
      bridge: {
        connected: true,
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
      },
    });
    this.log.info('bridge handshake complete');
    this.emit('connected');
  }

  async onDirective(msg) {
    const log = this.log.child({ requestId: msg.requestId });
    log.info(
      { directiveNs: msg.directive?.header?.namespace, directiveName: msg.directive?.header?.name },
      'directive received',
    );
    await this.state.update({ lastDirectiveAt: new Date().toISOString() });

    // ---- HMAC verification ------------------------------------------------
    // Verify before invoking the handler. In strict mode (default) a failure
    // sends an INVALID_AUTHORIZATION_CREDENTIAL error and the directive never
    // touches the Loxone command path. In permissive mode we log and continue
    // — only intended for the transitional window where the legacy e2e test
    // rig posts placeholder "fake" signatures.
    let verifyOk = false;
    let verifyReason = null;
    try {
      verifyDirective({
        directive: msg.directive,
        headers: msg.headers,
        skillSecret: this.identity.skillSecretBytes,
      });
      verifyOk = true;
    } catch (err) {
      verifyReason = err instanceof VerifyError ? err.reason : 'verify_threw';
      if (AUTH_MODE === 'strict') {
        log.warn({ reason: verifyReason, mode: AUTH_MODE }, 'directive signature rejected');
        const response = buildAuthError(msg.directive, verifyReason);
        safeSend(this.ws, { type: 'response', requestId: msg.requestId, response });
        return;
      }
      log.warn({ reason: verifyReason, mode: AUTH_MODE }, 'directive signature failed but mode is permissive — continuing');
    }
    if (verifyOk) log.debug('directive signature verified');

    // Record the pairing this directive came from (display-only — these
    // header fields are NOT covered by the HMAC, so they're informational).
    if (this.pairings && msg.headers) {
      const headers = lowerKeys(msg.headers);
      try {
        await this.pairings.observe({
          pairingId:   headers['x-aloxberry-pairing-id'],
          pairingName: headers['x-aloxberry-pairing-name'],
          directiveNs:   msg.directive?.header?.namespace,
          directiveName: msg.directive?.header?.name,
        });
      } catch (err) {
        // Never block directive handling on a tracker glitch.
        log.warn({ err: err.message }, 'pairings.observe threw');
      }
    }

    let response;
    if (this.directiveHandler) {
      try {
        response = await this.directiveHandler(msg.directive, { headers: msg.headers, log });
      } catch (err) {
        log.error({ err: err.message }, 'directive handler threw — sending INTERNAL_ERROR back');
        response = buildInternalError(msg.directive, err.message);
      }
    } else {
      // No handler registered — daemon misconfigured. Reply with an error
      // rather than letting the bridge dispatch time out at 10s (which would
      // surface as a generic ENDPOINT_UNREACHABLE to Alexa).
      log.warn('no directiveHandler registered — replying INTERNAL_ERROR');
      response = buildInternalError(msg.directive, 'daemon has no directive handler wired');
    }

    safeSend(this.ws, {
      type: 'response',
      requestId: msg.requestId,
      response,
    });
  }

  async onClose(code, reasonBuf) {
    const reason = reasonBuf ? reasonBuf.toString() : '';
    if (this.welcomeTimer) {
      clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
    // Drain any pending pair-publish awaiters — they can't be answered if the
    // socket is gone. Caller can retry once the new connection comes up.
    for (const [, awaiter] of this.pendingPairPublishes) {
      clearTimeout(awaiter.timer);
      awaiter.reject(new Error('bridge_disconnected'));
    }
    this.pendingPairPublishes.clear();

    const action = CLOSE_ACTIONS[code] || DEFAULT_CLOSE_ACTION;
    await this.state.update({
      bridge: {
        connected: false,
        lastError: `${action.reason} (close=${code}${reason ? ` "${reason}"` : ''})`,
      },
    });
    this.log.info({ code, reason, action: action.reason, willRetry: action.retry }, 'bridge socket closed');
    this.ws = null;

    if (this.stopped) return;
    if (this.suspended) {
      this.log.info('not reconnecting — master switch off');
      return;
    }

    // `wantsReconnect` is set by forceReconnect() to override the CLOSE_ACTIONS
    // policy. Without this, a deliberate reconnect (e.g. after identity
    // rotation) closes with code 1000 → policy says "no retry" → the daemon
    // sits permanently disconnected until the operator restarts it.
    const force = this.wantsReconnect === true;
    this.wantsReconnect = false; // one-shot consume

    if (!force && !action.retry) {
      this.log.warn({ code, reason: action.reason }, 'not reconnecting — operator intervention required');
      this.emit('giveup', { code, reason: action.reason });
      return;
    }
    if (force) {
      this.log.info({ code, reason: action.reason }, 'reconnect after forced close');
    }
    this.scheduleReconnect();
  }

  // Publish a one-shot pair entry via the existing authenticated WSS
  // connection. The bridge stores `{code → {userId, skillSecret}}` keyed by
  // our hello-handshake userId (so we cannot publish under someone else's
  // userId by design).
  //
  // Returns a Promise that resolves on `pair-publish-ok` (or rejects on
  // `pair-publish-error` / disconnect / timeout).
  publishPairCode(code, { timeoutMs = 5000 } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('bridge_not_connected'));
    }
    if (!this.connectedOnce) {
      // We've never completed the hello → welcome dance. Refuse — the
      // bridge would treat any non-hello message as protocol error.
      return Promise.reject(new Error('bridge_handshake_incomplete'));
    }
    const requestId = `pp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingPairPublishes.delete(requestId)) {
          reject(new Error('pair_publish_timeout'));
        }
      }, timeoutMs);

      this.pendingPairPublishes.set(requestId, { resolve, reject, timer });

      safeSend(this.ws, {
        type: 'pair-publish',
        requestId,
        code,
        skillSecret: this.identity.skillSecret,
      });
    });
  }

  // Internal: ack/error handler invoked from onMessage.
  resolvePairPublish(requestId, err) {
    if (!requestId) return;
    const awaiter = this.pendingPairPublishes.get(requestId);
    if (!awaiter) return;
    this.pendingPairPublishes.delete(requestId);
    clearTimeout(awaiter.timer);
    if (err) awaiter.reject(err);
    else awaiter.resolve();
  }

  // Send a Phase-4 proactive ChangeReport up the WSS. The caller (state-
  // reporter) has already signed `payload` with the per-pairing skillSecret
  // and hands us the canonical string + headers. Bridge forwards opaque to
  // the Lambda's /event endpoint — same end-to-end HMAC pattern as inbound
  // directives, just in the reverse direction.
  //
  // Returns true if the frame was queued for sending, false if the socket
  // isn't ready (caller can choose to drop or queue). We do NOT buffer
  // locally: a late report is worse than a missed one for state updates,
  // and the next transition will overwrite the missed one anyway.
  sendReport({ timestamp, signature, payload }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connectedOnce) {
      this.log.debug('bridge not connected — dropping ChangeReport');
      return false;
    }
    safeSend(this.ws, {
      type: 'report',
      timestamp,
      signature,
      payload,
    });
    return true;
  }

  // Trigger a fresh reconnect cycle. Used by local-http POST /reset-pairings
  // after the identity has been rotated, so the bridge sees the new userId.
  //
  // We close with code 1000 (normal_close), which the CLOSE_ACTIONS table
  // maps to "no retry" by default. To override that policy we set
  // `wantsReconnect` BEFORE closing — onClose checks the flag and treats
  // this as a retry regardless of close code.
  //
  // We also reset the backoff to its initial value: this is a deliberate
  // reconnect, not the tail of a network failure, so the next attempt
  // should happen at the initial delay (1 s) not at whatever backed-off
  // delay we'd inherited from prior outages.
  forceReconnect(reason) {
    if (this.stopped) return;
    this.log.warn({ reason }, 'forced reconnect requested');
    this.connectedOnce = false;
    this.wantsReconnect = true;
    this.currentBackoffMs = this.config.reconnectInitialMs;
    if (this.ws) {
      try { this.ws.close(1000, reason || 'forced reconnect'); }
      catch { /* ignore — close handler runs reconnect path */ }
    } else if (!this.reconnectTimer) {
      // No socket at all: kick the loop directly.
      this.connect();
    }
  }

  onError(err) {
    // 'close' will follow with a code; do the state-mutation there to avoid
    // duplicate updates. Just log the underlying error here.
    this.log.warn({ err: err.message }, 'bridge socket error');
  }

  scheduleReconnect() {
    if (this.stopped || this.suspended || this.reconnectTimer) return;
    const jitter = 1 + (Math.random() * 0.5 - 0.25); // ±25 %
    const delay = Math.min(
      Math.round(this.currentBackoffMs * jitter),
      this.config.reconnectMaxMs,
    );
    this.log.info({ delayMs: delay, backoffMs: this.currentBackoffMs }, 'scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // Double for next attempt, capped.
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.config.reconnectMaxMs);
  }
}

// ----- helpers ---------------------------------------------------------------

// Last-resort error response used when the daemon's directive handler is
// either missing or itself throws. Echoes the Alexa header shape minimally.
function buildInternalError(directive, message) {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        payloadVersion: '3',
        messageId: directive?.header?.messageId || 'daemon-error',
        correlationToken: directive?.header?.correlationToken,
      },
      payload: { type: 'INTERNAL_ERROR', message: message || 'internal daemon error' },
    },
  };
}

// HMAC verification failure. We use INVALID_AUTHORIZATION_CREDENTIAL rather
// than INTERNAL_ERROR so Alexa surfaces "please re-link your account" — which
// is the right user-facing outcome if the per-user skillSecret has rotated.
function buildAuthError(directive, reason) {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        payloadVersion: '3',
        messageId: directive?.header?.messageId || 'daemon-auth-error',
        correlationToken: directive?.header?.correlationToken,
      },
      payload: {
        type: 'INVALID_AUTHORIZATION_CREDENTIAL',
        message: `directive signature failed verification (${reason})`,
      },
    },
  };
}

function buildWsUrl(httpUrl, path) {
  let parsed;
  try {
    parsed = new URL(httpUrl);
  } catch (err) {
    throw new Error(`BRIDGE_URL is not a valid URL: ${err.message}`);
  }
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  else if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error(`BRIDGE_URL must be http(s) or ws(s), got ${parsed.protocol}`);
  }
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function lowerKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // ignore; close handler will run
  }
}

function safeClose(ws, code, reason) {
  if (!ws) return;
  try {
    ws.close(code, reason);
  } catch {
    // ignore
  }
}

module.exports = { BridgeClient, buildWsUrl };
