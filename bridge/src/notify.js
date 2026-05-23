'use strict';

// Lambda → bridge → daemon push notifications.
//
// Mirrors /dispatch in shape but is fire-and-forget: there is no awaiter,
// no requestId, no timeout-tied promise. Lambda calls this when something
// has happened that the plugin UI should learn about without waiting for
// the daemon's next welcome handshake (e.g. an LWA refresh token was just
// flagged `invalid_grant` for one of the linked Alexa accounts).
//
// If the daemon is offline, the notification is dropped on the floor —
// the daemon refetches its current health on the next WSS welcome, so a
// missed push is self-healing.

const routing = require('./routing');

function deliver(bridgeUserId, notification) {
  const ws = routing.get(bridgeUserId);
  if (!ws || ws.readyState !== ws.OPEN) {
    return { ok: false, reason: 'offline' };
  }
  try {
    ws.send(JSON.stringify({ type: 'notification', notification }));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'send_failed', error: err.message };
  }
}

module.exports = { deliver };
