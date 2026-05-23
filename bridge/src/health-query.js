'use strict';

// Bridge → Lambda /health-query — called once per daemon WSS welcome to
// fetch the current link state (revoked accounts, etc.) and forward it to
// the daemon as a `health-snapshot` notification. This is the self-healing
// path: any link-revocation that happened while the daemon was disconnected
// (bridge restart, daemon offline, network outage) is delivered on
// reconnect.
//
// The URL is derived from LAMBDA_EVENT_URL — the operator already provides
// that for outbound /event — so existing bridge deployments don't need a
// new env var.

const BRIDGE_DISPATCH_SECRET = process.env.BRIDGE_DISPATCH_SECRET || '';
const LAMBDA_EVENT_URL = process.env.LAMBDA_EVENT_URL || '';

// Swap the trailing /event for /health-query. The two endpoints live on
// the same Lambda (oauth-handler), so the base URL is identical.
function healthQueryUrl() {
  if (!LAMBDA_EVENT_URL) return '';
  return LAMBDA_EVENT_URL.replace(/\/event(?:\/+)?$/, '/health-query');
}

const FETCH_TIMEOUT_MS = 3000;

async function fetchSnapshot(bridgeUserId, log) {
  const url = healthQueryUrl();
  if (!url) {
    // No Lambda URL configured: silently return an empty-but-valid snapshot
    // so the daemon's handler can run uniformly. Operator already sees the
    // LAMBDA_EVENT_URL warning from outbound.js — no need to repeat it.
    return { linked: 0, revoked: [] };
  }
  if (!BRIDGE_DISPATCH_SECRET) return { linked: 0, revoked: [] };

  let res;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: {
        'content-type':  'application/json',
        'x-bridge-auth': BRIDGE_DISPATCH_SECRET,
      },
      body:    JSON.stringify({ bridgeUserId }),
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (log) log.warn({ err: err.message }, 'health-query fetch failed');
    return null;
  }
  if (!res.ok) {
    if (log) log.warn({ status: res.status }, 'health-query non-2xx');
    return null;
  }
  try {
    return await res.json();
  } catch {
    if (log) log.warn('health-query body not json');
    return null;
  }
}

module.exports = { fetchSnapshot };
