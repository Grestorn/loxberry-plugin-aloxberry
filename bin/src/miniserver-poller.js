'use strict';

// Polling-mode Miniserver state acquisition — the no-permanent-connection
// alternative to the long-lived MiniserverSession.
//
// Why this exists: even with the active keepalive probe + activity watchdog
// (miniserver-ws.js) and the 503 backoff floor (miniserver-session.js), a
// Gen 2 Miniserver's embedded network stack has still crashed under a
// permanent WebSocket (last observed 2026-06-11, ~3 weeks after the
// previous incident). Poll mode removes the long-lived connection from the
// equation entirely: every `intervalMs` the poller runs ONE short cycle —
//
//   connect → keyexchange → auth (cached JWT fast path) →
//   enablebinstatusupdate → receive the full initial state dump →
//   clean close
//
// — and is fully disconnected between cycles. The Miniserver pushes its
// complete state table within seconds of enablebinstatusupdate, so a cycle
// holds a socket for only a few seconds. The state lands in the SAME
// MiniserverStateCache as live mode; because the cache emits 'change' only
// on value *transitions* (not first insertion), each dump produces exactly
// the diffs since the previous poll — ChangeReports keep working, just
// with up-to-one-interval latency.
//
// Why a short-lived WS instead of HTTP jdev polling: text-states (light
// moods etc.) are not readable via jdev/sps/io, and per-UUID HTTP polling
// would cost one authenticated request per state UUID per cycle. One WS
// dump is a single connection and reuses the entire existing decode path.
//
// Lifecycle contract:
//   const poller = new MiniserverPoller({ sessionFactory, stateCache, intervalMs, log });
//   poller.on('poll-ok',     ({ eventsApplied, durationMs }) => ...);
//   poller.on('poll-failed', ({ reason }) => ...);
//   poller.start();          // first cycle runs immediately
//   await poller.stop();     // aborts an in-flight cycle, cancels the schedule
//
// sessionFactory() must return a FRESH MiniserverSession constructed with
// autoReconnect: false — the poller's schedule is the only retry loop. A
// failed cycle is not retried early; the next scheduled cycle is the retry.

const EventEmitter = require('node:events');

// A cycle that hasn't reached 'subscribed' within this window is dead —
// covers TCP connect + keyexchange + auth + subscribe ack on a slow LAN.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
// The initial dump is considered complete once the state cache has seen no
// new events for this long...
const DEFAULT_SETTLE_QUIET_MS = 2_500;
// ...but never wait longer than this for quiet (a busy installation emits
// live events continuously — at some point we have a full-enough snapshot).
const DEFAULT_SETTLE_MAX_MS = 20_000;

const SETTLE_TICK_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

class MiniserverPoller extends EventEmitter {
  constructor({
    sessionFactory, stateCache, intervalMs, log,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    settleQuietMs = DEFAULT_SETTLE_QUIET_MS,
    settleMaxMs = DEFAULT_SETTLE_MAX_MS,
    settleTickMs = SETTLE_TICK_MS,           // test hook
  }) {
    super();
    this.sessionFactory = sessionFactory;
    this.stateCache = stateCache;
    this.intervalMs = intervalMs;
    this.log = log.child({ component: 'miniserver-poller' });
    this.connectTimeoutMs = connectTimeoutMs;
    this.settleQuietMs = settleQuietMs;
    this.settleMaxMs = settleMaxMs;
    this.settleTickMs = settleTickMs;

    this.stopped = false;
    this.timer = null;
    this.activeSession = null;
    this.cycleRunning = false;
  }

  start() {
    if (this.stopped) throw new Error('cannot start a stopped poller');
    this.log.info(
      { intervalMs: this.intervalMs },
      'poll mode active — no permanent miniserver connection will be held',
    );
    // First cycle immediately; the schedule continues from each cycle's end.
    this._runCycle();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeSession) {
      try { await this.activeSession.stop(); } catch { /* ignore */ }
      this.activeSession = null;
    }
    this.log.info('poller stopped');
  }

  // ----- one poll cycle ------------------------------------------------------

  async _runCycle() {
    if (this.stopped || this.cycleRunning) return;
    this.cycleRunning = true;
    const startedAt = Date.now();
    const eventsBefore = this.stateCache.eventsSeen;

    const session = this.sessionFactory();
    this.activeSession = session;
    let outcome;
    try {
      await this._connectAndSubscribe(session);
      await this._awaitSettle(session);
      outcome = {
        ok: true,
        eventsApplied: this.stateCache.eventsSeen - eventsBefore,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      outcome = { ok: false, reason: err.message, durationMs: Date.now() - startedAt };
    } finally {
      // Always tear the session down — a clean close() (not terminate) so
      // the Miniserver's side of the socket is released immediately instead
      // of lingering in CLOSE_WAIT, which is the very failure mode poll
      // mode exists to avoid.
      try { await session.stop(); } catch { /* ignore */ }
      this.activeSession = null;
      this.cycleRunning = false;
    }

    if (outcome.ok) {
      this.log.info(
        { eventsApplied: outcome.eventsApplied, durationMs: outcome.durationMs },
        'poll cycle complete',
      );
      this.emit('poll-ok', outcome);
    } else if (!this.stopped) {
      this.log.warn(
        { reason: outcome.reason, durationMs: outcome.durationMs },
        'poll cycle failed — next scheduled cycle is the retry',
      );
      this.emit('poll-failed', outcome);
    }

    this._scheduleNext();
  }

  // Resolve when the session reports 'subscribed'; reject on 'disconnected'
  // (the session's normalized failure event — autoReconnect:false means
  // nothing follows it) or on timeout.
  _connectAndSubscribe(session) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.removeListener('subscribed', onSubscribed);
        session.removeListener('disconnected', onDisconnected);
        fn(arg);
      };
      const onSubscribed = () => finish(resolve);
      const onDisconnected = (info) => finish(
        reject,
        new Error(info?.reason || (info?.code ? `socket closed (${info.code})` : 'disconnected')),
      );
      const timer = setTimeout(
        () => finish(reject, new Error(`poll connect timeout after ${this.connectTimeoutMs} ms`)),
        this.connectTimeoutMs,
      );
      timer.unref();
      session.once('subscribed', onSubscribed);
      session.once('disconnected', onDisconnected);
      // start() resolves before subscribe completes its grace period in some
      // paths and _connectOnce swallows its own errors (emitting
      // 'disconnected' instead), so the events above are the real signal.
      // The catch is belt-and-braces for a synchronous throw.
      session.start().catch((err) => finish(reject, err));
    });
  }

  // Wait for the initial dump to finish: no new events for settleQuietMs,
  // capped at settleMaxMs. An early disconnect ends the wait — whatever
  // landed in the cache before the drop is still a valid partial refresh,
  // but the cycle is reported as failed so the UI shows the truth.
  async _awaitSettle(session) {
    const deadline = Date.now() + this.settleMaxMs;
    let lastCount = this.stateCache.eventsSeen;
    let lastChangeAt = Date.now();
    let dropped = null;
    const onDisconnected = (info) => { dropped = info || {}; };
    session.once('disconnected', onDisconnected);
    try {
      while (!this.stopped && Date.now() < deadline) {
        if (dropped) {
          throw new Error(dropped.reason || 'connection dropped during state dump');
        }
        const count = this.stateCache.eventsSeen;
        if (count !== lastCount) {
          lastCount = count;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= this.settleQuietMs) {
          return; // dump has gone quiet — snapshot complete
        }
        await sleep(this.settleTickMs);
      }
    } finally {
      session.removeListener('disconnected', onDisconnected);
    }
    // settleMaxMs elapsed with continuous traffic — that's still a success
    // (we have at least one full dump plus live churn on top).
  }

  _scheduleNext() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._runCycle();
    }, this.intervalMs);
    this.timer.unref();
    this.log.debug({ inMs: this.intervalMs }, 'next poll scheduled');
  }
}

module.exports = { MiniserverPoller };
