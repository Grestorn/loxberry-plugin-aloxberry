'use strict';

// LWA (Login With Amazon) helpers for Phase 4 outbound events.
//
// `exchangeLwaCode` is intentionally left in alexa-handler/index.js for now —
// it's invoked exactly once per skill-link in AcceptGrant. The refresh path
// runs on every ChangeReport, so it lives here for re-use across handlers
// (today: oauth-handler /event; tomorrow: any future scheduled-reporter).
//
// Same SSM credential lookup as alexa-handler. Both Lambdas read the same
// LWA_CLIENT_ID_PARAM / LWA_CLIENT_SECRET_PARAM env vars, and getSecureParam
// caches the values in-process for 5 minutes — so a hot oauth-handler doing
// 100 ChangeReports/min hits SSM ~12 times per hour total, not 100/min.

const { getSecureParam } = require('./ssm');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

// Alexa Event Gateway endpoint by region. The skill's marketplace
// determines which region's gateway to use. For now we deploy EU-only;
// a per-user mapping can land here later if we ever expand.
//
// IMPORTANT: hostnames are `amazonalexa.com`, NOT `amazonaws.com` — those
// are two distinct Amazon API namespaces. The DNS-resolver-error catch:
// `amazonaws.com` is the public root for AWS service APIs (the wrong
// namespace), `amazonalexa.com` is the Alexa side. Same company, separate
// DNS zones.
const EVENT_GATEWAY_URL_EU = 'https://api.eu.amazonalexa.com/v3/events';
// const EVENT_GATEWAY_URL_NA = 'https://api.amazonalexa.com/v3/events';
// const EVENT_GATEWAY_URL_FE = 'https://api.fe.amazonalexa.com/v3/events';

const REFRESH_TIMEOUT_MS = 5000;
const EVENT_POST_TIMEOUT_MS = 5000;

async function getLwaCredentials() {
  const clientIdParam     = process.env.LWA_CLIENT_ID_PARAM;
  const clientSecretParam = process.env.LWA_CLIENT_SECRET_PARAM;
  if (!clientIdParam || !clientSecretParam) {
    throw new Error('LWA SSM params are not configured (LWA_CLIENT_ID_PARAM / LWA_CLIENT_SECRET_PARAM)');
  }
  const [clientId, clientSecret] = await Promise.all([
    getSecureParam(clientIdParam),
    getSecureParam(clientSecretParam),
  ]);
  return { clientId, clientSecret };
}

// Exchange a stored refresh_token for a fresh access_token. Throws on
// any non-2xx from LWA — the caller decides whether to retry (we don't
// for ChangeReport: the next state change will mint a new attempt).
async function refreshLwaAccessToken(refreshToken) {
  if (!refreshToken) throw new Error('refreshLwaAccessToken: refreshToken is required');
  const { clientId, clientSecret } = await getLwaCredentials();
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal:  AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`LWA refresh failed: HTTP ${res.status} ${text}`);
    err.httpStatus = res.status;
    // LWA documents an `error` field in the JSON body for OAuth2 errors —
    // `invalid_grant` (token revoked/expired — terminal), `invalid_client`
    // (our credentials are wrong — operator alert), `invalid_request` /
    // `unauthorized_client` etc. Surface it so the caller can distinguish
    // "this user must re-link" from "retry next time".
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === 'string') {
        err.lwaError = parsed.error;
      }
    } catch {
      // Non-JSON body (e.g. LWA edge giving us an HTML 5xx page). Leave
      // lwaError unset; httpStatus is still there for the caller to switch on.
    }
    throw err;
  }
  const json = await res.json();
  if (!json.access_token) {
    throw new Error('LWA refresh response missing access_token');
  }
  return json.access_token;
}

// POST a ChangeReport (or any other event) to the Alexa Event Gateway.
// The caller has already filled `event.endpoint.scope.token` with the
// access_token returned by refreshLwaAccessToken.
//
// Returns { ok: true } on 2xx, { ok: false, status, body } on non-2xx.
// Network errors throw (caller logs).
async function postToEventGateway(eventBody) {
  const res = await fetch(EVENT_GATEWAY_URL_EU, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(eventBody),
    signal:  AbortSignal.timeout(EVENT_POST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
  return { ok: true };
}

module.exports = {
  LWA_TOKEN_URL,
  EVENT_GATEWAY_URL_EU,
  getLwaCredentials,
  refreshLwaAccessToken,
  postToEventGateway,
};
