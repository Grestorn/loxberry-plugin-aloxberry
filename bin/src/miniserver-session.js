'use strict';

// High-level Miniserver session.
//
// Wraps the low-level MiniserverWsClient with:
//   - Token cache (disk-persisted, chmod 600)
//   - Authentication choice: cached token → authwithtoken (fast path);
//     no cache or token rejected → full getjwt (slow path, needs credentials)
//   - Periodic refreshjwt to extend cached token before expiry
//   - WS reconnect on drop with exponential backoff + jitter
//   - Event dispatch into a state cache (optional)
//
// Designed so the daemon's index.js does:
//
//   const session = new MiniserverSession({
//     msConfig, publicKey, getCredentials, tokenStore, stateCache,
//     daemonUuid, log,
//   });
//   session.on('subscribed', () => log.info('miniserver session ready'));
//   await session.start();
//   // … runs forever until session.stop() …
//
// The session never throws into the caller during steady state — operational
// errors become 'disconnected' / 'auth-failed' events and trigger reconnect.

const EventEmitter = require('node:events');

const { MiniserverWsClient } = require('./miniserver-ws');
const { decodeEventPayload } = require('./miniserver-events');
const c = require('./miniserver-crypto');
const { LOXONE_EPOCH_MS, SECONDS_PER_DAY } = require('./miniserver-token-store');

const PERMISSION_APP = 4;
const CLIENT_INFO_NAME = 'aloxberry-daemon';
// Refresh halfway through the token's remaining lifetime, capped at 7 days
// (so we don't go more than a week between health checks of our own token).
const REFRESH_CAP_MS = 7 * SECONDS_PER_DAY * 1000;
// Lower bound — never schedule a refresh < 60s away, to avoid tight retry loops
// on a brand-new token that comes back with a very-near `validUntil`.
const REFRESH_MIN_MS = 60_000;

// Reconnect backoff (matches the bridge-client values).
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
// When the Miniserver itself signals overload (HTTP 503), aggressive
// retries make things worse — they keep adding pressure to a TCP socket
// table that's already at capacity (suspected cause of the Ethernet-stack
// hangs we saw 2026-05-2x). Floor the next reconnect at this value when
// 503 is seen, so we step back and give the embedded stack room to recover.
const OVERLOAD_BACKOFF_FLOOR_MS = 30_000;

class MiniserverSession extends EventEmitter {
  constructor({
    msConfig, publicKey, getCredentials, tokenStore, stateCache,
    daemonUuid, log,
    // Poll mode (miniserver-poller.js) runs one short-lived session per
    // cycle: a dropped/failed connection ends the cycle instead of being
    // retried here — the poller's own schedule is the retry. false
    // disables _scheduleReconnect entirely; everything else is unchanged.
    autoReconnect = true,
    // Test hooks
    reconnectInitialMs = RECONNECT_INITIAL_MS,
    reconnectMaxMs = RECONNECT_MAX_MS,
    refreshLeadSeconds = 0,        // schedule refresh this far before validUntil (test override)
  }) {
    super();
    this.msConfig = msConfig;
    this.publicKey = publicKey;
    this.getCredentials = getCredentials;
    this.tokenStore = tokenStore;
    this.stateCache = stateCache || null;
    this.daemonUuid = daemonUuid;
    this.autoReconnect = autoReconnect;
    this.log = log.child({ component: 'miniserver-session' });
    this.reconnectInitialMs = reconnectInitialMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.refreshLeadSeconds = refreshLeadSeconds;

    this.wsClient = null;
    this.currentToken = null;        // { token, key, validUntil, snr, username }
    this.stopped = false;
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.currentBackoffMs = this.reconnectInitialMs;
  }

  async start() {
    if (this.stopped) throw new Error('cannot start a stopped session');
    await this._connectOnce();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this._clearTimers();
    if (this.wsClient) {
      try { await this.wsClient.stop(); } catch { /* ignore */ }
      this.wsClient = null;
    }
    this.log.info('session stopped');
  }

  // ----- one connect-auth-subscribe cycle ------------------------------------

  async _connectOnce() {
    if (this.stopped) return;

    this.wsClient = new MiniserverWsClient({
      msConfig: this.msConfig,
      publicKey: this.publicKey,
      log: this.log,
    });

    try {
      await this.wsClient.start();    // keyexchange
      const usedToken = await this._authenticate();
      this.log.info({ via: usedToken ? 'authwithtoken' : 'getjwt' }, 'authenticated');
      this.emit('authenticated', { viaCachedToken: usedToken });

      // Subscribe + wire up event ingestion + lifecycle.
      this.wsClient.on('binary-payload', (p) => this._handleBinaryPayload(p));
      this.wsClient.on('close', (info) => this._handleClose(info));
      this.wsClient.on('error', (err) => this.log.warn({ err: err.message }, 'ws error (close will follow)'));
      await this.wsClient.subscribeBinaryEvents();
      this.emit('subscribed');

      this._scheduleRefresh();
      // Successful cycle resets backoff.
      this.currentBackoffMs = this.reconnectInitialMs;
    } catch (err) {
      this.log.warn({ err: err.message }, 'connect cycle failed');

      // 503 means "Miniserver socket table is full". Hitting it harder
      // makes the situation worse. Raise the floor for the next attempt
      // so we back off long enough for the embedded stack to drain
      // CLOSE_WAIT/TIME_WAIT slots. ws library exposes the upgrade status
      // as err.statusCode in some cases; in others only err.message has it
      // (format: "Unexpected server response: 503"). Check both.
      const statusCode = err?.statusCode;
      const is503 = statusCode === 503
        || /(?:^|\D)503(?:\D|$)/.test(err?.message || '');
      if (is503 && this.currentBackoffMs < OVERLOAD_BACKOFF_FLOOR_MS) {
        this.log.warn(
          { wasMs: this.currentBackoffMs, floorMs: OVERLOAD_BACKOFF_FLOOR_MS },
          'Miniserver returned 503 (socket pressure) — raising reconnect floor',
        );
        this.currentBackoffMs = OVERLOAD_BACKOFF_FLOOR_MS;
      }

      try { await this.wsClient?.stop(); } catch { /* ignore */ }
      this.wsClient = null;
      this.emit('disconnected', { reason: err.message });
      this._scheduleReconnect();
    }
  }

  // Returns true if we authenticated with cached token, false if full getjwt.
  async _authenticate() {
    const expectedSnr = undefined; // we don't know SNR until apiKey probe — defer
    const cached = await this.tokenStore.load({
      expectedSnr,
      expectedUsername: this._lastUsername(),
    });

    if (cached) {
      try {
        await this._authWithToken(cached);
        this.currentToken = cached;
        return true;
      } catch (err) {
        this.log.warn({ err: err.message }, 'authwithtoken failed — falling back to getjwt');
        // Don't clear the cache yet — getjwt may still succeed; if it does
        // we overwrite anyway. If it doesn't, the cache is the least of our
        // problems.
      }
    }

    await this._fullAuthAndCache();
    return false;
  }

  async _authWithToken(stored) {
    // Fresh getkey2 (key rotates per call).
    const k2 = await this.wsClient.sendEncrypted(`jdev/sys/getkey2/${stored.username}`);
    if (k2?.LL?.Code !== '200') throw new Error(`getkey2 failed: Code=${k2?.LL?.Code}`);
    const { key, hashAlg } = k2.LL.value;
    const hash = c.tokenHmac(key, stored.token, hashAlg);
    // NOTE: authwithtoken is a WS-only command with NO "jdev/sys/" prefix —
    // unlike getjwt/refreshjwt which do. Per protocol PDF p.27 and confirmed
    // against PyLoxone. Adding the prefix returns Code:400 (Bad Request).
    const response = await this.wsClient.sendEncrypted(`authwithtoken/${hash}/${stored.username}`);
    if (response?.LL?.Code !== '200') throw new Error(`authwithtoken failed: Code=${response?.LL?.Code}`);
  }

  async _fullAuthAndCache() {
    const creds = await this.getCredentials();
    if (!creds || !creds.username || !creds.password) {
      throw new Error('getCredentials returned empty username/password');
    }
    const k2 = await this.wsClient.sendEncrypted(`jdev/sys/getkey2/${creds.username}`);
    if (k2?.LL?.Code !== '200') throw new Error(`getkey2 failed: Code=${k2?.LL?.Code}`);
    const { key, salt, hashAlg } = k2.LL.value;
    const pwHash = c.passwordHash(creds.password, salt, hashAlg);
    const hash = c.userHmac(key, creds.username, pwHash, hashAlg);
    const info = encodeURIComponent(CLIENT_INFO_NAME);
    const inner = `jdev/sys/getjwt/${hash}/${creds.username}/${PERMISSION_APP}/${this.daemonUuid}/${info}`;
    const response = await this.wsClient.sendEncrypted(inner);
    if (response?.LL?.Code !== '200') throw new Error(`getjwt failed: Code=${response?.LL?.Code}`);
    const v = response.LL.value;
    this.currentToken = {
      snr: this._lastSnr(),     // may be null on first connect; updated lazily
      username: creds.username,
      token: v.token,
      key: v.key,
      validUntil: v.validUntil,
    };
    await this.tokenStore.save(this.currentToken);
    this.emit('token-acquired', this._tokenSummary());
  }

  // ----- token refresh -------------------------------------------------------

  _scheduleRefresh() {
    this._clearRefreshTimer();
    if (!this.currentToken) return;
    const validUntilMs = LOXONE_EPOCH_MS + this.currentToken.validUntil * 1000;
    const remaining = validUntilMs - Date.now();
    if (remaining <= 0) {
      this.log.warn('token already expired? scheduling immediate refresh anyway');
      this.refreshTimer = setTimeout(() => this._refresh(), REFRESH_MIN_MS).unref();
      return;
    }
    // Refresh halfway, capped at 7 days, minimum 60s away.
    const target = Math.max(REFRESH_MIN_MS, Math.min(remaining / 2, REFRESH_CAP_MS));
    this.refreshTimer = setTimeout(() => this._refresh(), target).unref();
    this.log.info({ inSeconds: Math.round(target / 1000) }, 'scheduled token refresh');
  }

  async _refresh() {
    if (!this.currentToken || !this.wsClient) return;
    try {
      const k2 = await this.wsClient.sendEncrypted(`jdev/sys/getkey2/${this.currentToken.username}`);
      if (k2?.LL?.Code !== '200') throw new Error(`refresh getkey2 failed: Code=${k2?.LL?.Code}`);
      const { key, hashAlg } = k2.LL.value;
      const tokenHash = c.tokenHmac(key, this.currentToken.token, hashAlg);
      const response = await this.wsClient.sendEncrypted(
        `jdev/sys/refreshjwt/${tokenHash}/${this.currentToken.username}`,
      );
      if (response?.LL?.Code !== '200') throw new Error(`refreshjwt failed: Code=${response?.LL?.Code}`);
      const v = response.LL.value;
      this.currentToken.validUntil = v.validUntil;
      if (v.key) this.currentToken.key = v.key;
      await this.tokenStore.save(this.currentToken);
      this.log.info(this._tokenSummary(), 'token refreshed');
      this.emit('token-refreshed', this._tokenSummary());
      this._scheduleRefresh();
    } catch (err) {
      // Don't fail the session — just log and try again next time. If the
      // socket dropped underneath us the close handler will handle reconnect.
      this.log.warn({ err: err.message }, 'token refresh failed; will retry on next opportunity');
    }
  }

  // ----- event ingestion -----------------------------------------------------

  _handleBinaryPayload({ identifier, data }) {
    if (!this.stateCache) return;
    try {
      const decoded = decodeEventPayload(identifier, data);
      this.stateCache.ingest(decoded);
    } catch (err) {
      this.log.warn({ err: err.message, identifier }, 'failed to decode binary payload');
    }
  }

  // ----- close + reconnect ---------------------------------------------------

  _handleClose(info) {
    this._clearTimers();
    this.wsClient = null;
    this.emit('disconnected', info);
    if (this.stopped) return;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.autoReconnect) return;   // poll mode: the poller owns retry cadence
    if (this.stopped || this.reconnectTimer) return;
    const jitter = 1 + (Math.random() * 0.5 - 0.25);
    const delay = Math.min(Math.round(this.currentBackoffMs * jitter), this.reconnectMaxMs);
    this.log.info({ delayMs: delay, baseMs: this.currentBackoffMs }, 'scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectOnce();
    }, delay).unref();
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.reconnectMaxMs);
  }

  // ----- helpers -------------------------------------------------------------

  _tokenSummary() {
    if (!this.currentToken) return { hasToken: false };
    const validUntilMs = LOXONE_EPOCH_MS + this.currentToken.validUntil * 1000;
    return {
      hasToken: true,
      validUntil: new Date(validUntilMs).toISOString(),
      remainingDays: ((validUntilMs - Date.now()) / 86_400_000).toFixed(1),
    };
  }

  _lastUsername() {
    return this.currentToken?.username;
  }
  _lastSnr() {
    return this.currentToken?.snr || null;
  }

  _clearTimers() {
    this._clearRefreshTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  _clearRefreshTimer() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

module.exports = { MiniserverSession };
