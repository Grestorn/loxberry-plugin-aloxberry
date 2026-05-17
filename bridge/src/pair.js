'use strict';

// Ephemeral pair-code rendezvous.
//
// Path B (one-shot pairing) routes the daemon's {userId, skillSecret} through
// the bridge so the Alexa OAuth handler can claim it via a short human-typed
// code. The flow:
//
//   1. User clicks "Show pair code" in the plugin's web UI.
//   2. Daemon picks a fresh 10-char code, sends it + its own skillSecret over
//      the existing WSS connection as a `pair-publish` message.
//      Bridge already knows the daemon's userId from the hello handshake.
//   3. Bridge stores {code → {userId, skillSecret, expiresAt}} here.
//   4. User pastes the code into Alexa's account-linking form.
//   5. OAuth Lambda does GET /pair?code=X (with X-Bridge-Auth).
//      Bridge returns the entry and deletes it (one-shot read).
//   6. Lambda stores {bridgeUserId, skillSecret} in DynamoDB.
//
// TTL defaults to 10 min — long enough to copy through the Alexa flow, short
// enough that abandoned codes don't linger. A periodic sweeper bounds memory
// in case the GET-and-delete path is never exercised.
//
// This module is intentionally state-only: timer/sweeper lifecycle is owned
// here, but routing/WSS concerns live in ws-handlers.js, and HTTP serving
// lives in http-handlers.js. Easy to unit-test in isolation.

// Default 10 min. Overridable via PAIR_TTL_MS (milliseconds) for controlled,
// time-boxed scenarios such as Alexa certification review, where an external
// reviewer needs a longer-lived code. Keep any override modest (hours, not
// weeks) and remove it afterwards: the code is still one-shot, but a longer
// pre-redemption window is a wider exposure if it leaks. Default is unchanged
// so a normal deployment ships nothing weakened.
const DEFAULT_TTL_MS = Number.parseInt(process.env.PAIR_TTL_MS, 10) || 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const entries = new Map(); // code → { userId, skillSecret, expiresAt }

let sweepTimer = null;
function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  // unref so the bridge process can shut down even with this timer pending.
  sweepTimer.unref();
}

function sweep(now = Date.now()) {
  let removed = 0;
  for (const [code, entry] of entries) {
    if (entry.expiresAt <= now) {
      entries.delete(code);
      removed += 1;
    }
  }
  return removed;
}

// Store an entry. If the same code already exists, last-write-wins —
// collisions in a 50-bit code space across an in-memory window are
// astronomically rare in normal use; if a malicious caller is brute-forcing,
// they're already authenticated to bridge over WSS so they could publish
// anything they want under their own userId.
function store(code, { userId, skillSecret }, ttlMs = DEFAULT_TTL_MS) {
  if (typeof code !== 'string') throw new TypeError('code must be a string');
  if (typeof userId !== 'string') throw new TypeError('userId must be a string');
  if (typeof skillSecret !== 'string') throw new TypeError('skillSecret must be a string');
  ensureSweeper();
  entries.set(code, {
    userId,
    skillSecret,
    expiresAt: Date.now() + ttlMs,
  });
}

// One-shot read. Returns the entry if present and unexpired, otherwise null.
// On success the entry is deleted before returning, so a second take() for
// the same code returns null.
function take(code) {
  if (typeof code !== 'string') return null;
  const entry = entries.get(code);
  if (!entry) return null;
  entries.delete(code);
  if (entry.expiresAt <= Date.now()) return null;
  return { userId: entry.userId, skillSecret: entry.skillSecret };
}

function size() {
  return entries.size;
}

// Test-only escape hatch. Production code shouldn't need this.
function _resetForTests() {
  entries.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  store,
  take,
  size,
  sweep,
  _resetForTests,
  DEFAULT_TTL_MS,
};
