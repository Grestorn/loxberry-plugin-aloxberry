'use strict';

// Bridge → Lambda /clean — called when a daemon asks the bridge to delete
// its DDB user rows ("Remove broken links" or "Kill all pairings" buttons
// in the plugin UI). URL is derived from LAMBDA_EVENT_URL just like
// /health-query: same Lambda, same base, different path.

const BRIDGE_DISPATCH_SECRET = process.env.BRIDGE_DISPATCH_SECRET || '';
const LAMBDA_EVENT_URL = process.env.LAMBDA_EVENT_URL || '';

function cleanUrl() {
  if (!LAMBDA_EVENT_URL) return '';
  return LAMBDA_EVENT_URL.replace(/\/event(?:\/+)?$/, '/clean');
}

// Slightly longer than health-query: the Lambda may iterate a couple of
// dozen DeleteCommand calls back-to-back. Still bounded by API Gateway's
// 30s ceiling on /event-style endpoints — we expect well under 5s.
const FETCH_TIMEOUT_MS = 10000;

async function callClean(bridgeUserId, scope, log) {
  const url = cleanUrl();
  if (!url) {
    return { ok: false, error: 'lambda_url_not_configured' };
  }
  if (!BRIDGE_DISPATCH_SECRET) {
    return { ok: false, error: 'bridge_secret_not_configured' };
  }

  let res;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: {
        'content-type':  'application/json',
        'x-bridge-auth': BRIDGE_DISPATCH_SECRET,
      },
      body:    JSON.stringify({ bridgeUserId, scope }),
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (log) log.warn({ err: err.message, scope }, 'clean fetch failed');
    return { ok: false, error: err.message || 'fetch_failed' };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (log) log.warn({ status: res.status, body: text.slice(0, 200), scope }, 'clean non-2xx');
    return { ok: false, error: `http_${res.status}` };
  }
  try {
    const json = await res.json();
    return { ok: true, deleted: json.deleted || 0, revokedRemoved: json.revokedRemoved || [] };
  } catch {
    if (log) log.warn('clean body not json');
    return { ok: false, error: 'invalid_response' };
  }
}

module.exports = { callClean };
