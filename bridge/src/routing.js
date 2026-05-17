'use strict';

// In-memory routing table: userId -> { ws, lastSeenAt }.
//
// Pure state container. Lifecycle side-effects (closing displaced sockets,
// timer cleanup) live in ws-handlers.js so this module stays trivially
// testable. The bridge keeps no persistent state — a restart drops every
// entry, plugins reconnect within seconds.
//
// Security (P0 #5 hardening): `userId` is NOT a secret in this system (it
// travels in /dispatch bodies and historically appeared in logs). The
// bridge cannot cryptographically authenticate a connection without
// holding per-user skillSecret, which would break the privacy invariant.
// So we do the proportionate thing: an unauthenticated newcomer presenting
// a known userId may NOT displace a connection that is provably live
// (recent traffic). It may only take a slot whose socket is closed/closing
// or has gone silent past the staleness window (the legitimate
// reconnect-after-the-old-socket-died case). A nonce/skillSecret challenge
// verified Lambda-side is the tracked follow-up that removes the heuristic.

// A live plugin pongs every ~30s (HEARTBEAT_INTERVAL_MS); 60s of total
// silence means the socket is almost certainly gone. Env-overridable so
// tests can drive it fast.
const STALE_MS =
  Number.parseInt(process.env.ROUTING_STALE_MS, 10) || 60000;

const connections = new Map();

// Decide what to do with a hello for `userId` on socket `ws`. Returns:
//   { action: 'added' }                — slot was free; ws registered
//   { action: 'displaced', old: <ws> } — prior socket dead/stale; replaced
//   { action: 'rejected' }             — prior socket is live; ws NOT
//                                        registered (caller must close it)
function tryAdd(userId, ws, now = Date.now()) {
  const existing = connections.get(userId);
  if (!existing) {
    connections.set(userId, { ws, lastSeenAt: now });
    return { action: 'added' };
  }
  const ex = existing.ws;
  const open = ex && typeof ex.readyState === 'number' &&
    ex.OPEN !== undefined && ex.readyState === ex.OPEN;
  const stale = (now - existing.lastSeenAt) > STALE_MS;
  if (!open || stale) {
    connections.set(userId, { ws, lastSeenAt: now });
    return { action: 'displaced', old: ex };
  }
  // Prior socket is OPEN and showed recent traffic — treat the newcomer as
  // a potential hijack and refuse it. The legitimate plugin keeps its slot;
  // an attacker who only knows the userId cannot evict it.
  return { action: 'rejected' };
}

// Refresh liveness on any inbound traffic (pong, response, …) — only if
// `ws` still owns the slot, so a displaced socket's late messages can't
// keep a stale entry alive.
function touch(userId, ws, now = Date.now()) {
  const e = connections.get(userId);
  if (e && e.ws === ws) e.lastSeenAt = now;
}

// Removes the entry for userId only if the currently-mapped socket is the
// one passed in. Prevents a stale close-handler from evicting a replacement
// connection that already took the slot.
function remove(userId, ws) {
  const e = connections.get(userId);
  if (e && e.ws === ws) {
    connections.delete(userId);
    return true;
  }
  return false;
}

function get(userId) {
  const e = connections.get(userId);
  return e ? e.ws : undefined;
}

function has(userId) {
  return connections.has(userId);
}

function size() {
  return connections.size;
}

// Test seam.
function _resetForTests() {
  connections.clear();
}

module.exports = {
  tryAdd,
  touch,
  remove,
  get,
  has,
  size,
  _resetForTests,
  STALE_MS,
};
