'use strict';

// Pending dispatch awaiter registry.
//
// HTTP /dispatch creates an awaiter (a promise) keyed by requestId, sends a
// `directive` message to the plugin's WS, and waits. When the plugin sends a
// `response` message back, ws-handlers.js calls resolve() to settle the
// promise. Three failure paths short-circuit the wait:
//
//   1. Plugin offline at dispatch time (caller checks routing first, never
//      reaches this module).
//   2. Plugin disconnects mid-dispatch — ws close handler calls
//      rejectAllForUser() so dispatches fail-fast instead of timing out.
//   3. Timeout expires — built-in timer rejects with 'dispatch_timeout'.
//
// Keyed by requestId (not userId) so a single plugin can have multiple
// in-flight dispatches at the same time (Discovery + concurrent state).

const pending = new Map();

function register(requestId, userId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) {
        reject(new Error('dispatch_timeout'));
      }
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer, userId });
  });
}

// Plugin sent a `response` for this requestId. Returns true if there was a
// matching awaiter, false if not (response was late or duplicated).
function resolve(requestId, payload) {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve(payload);
  return true;
}

// Plugin's WS closed. Reject every dispatch currently waiting on this
// userId so HTTP callers see 504 immediately instead of after 10 s.
function rejectAllForUser(userId, reason) {
  let rejected = 0;
  for (const [requestId, entry] of pending) {
    if (entry.userId === userId) {
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      rejected += 1;
    }
  }
  return rejected;
}

function size() {
  return pending.size;
}

module.exports = {
  register,
  resolve,
  rejectAllForUser,
  size,
};
