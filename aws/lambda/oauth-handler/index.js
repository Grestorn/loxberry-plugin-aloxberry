'use strict';

const { randomUUID, createHash } = require('crypto');
const { Buffer } = require('buffer');
const {
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');

const { timingSafeEqual } = require('crypto');

const {
  getDocClient,
  tableNames,
  signAccessToken,
  getSecureParam,
  verifyRequest,
  HEADER_ALOXBERRY_TIMESTAMP,
  HEADER_ALOXBERRY_SIGNATURE,
  refreshLwaAccessToken,
  postToEventGateway,
  log,
} = require('@aloxberry/shared');

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Auth-code TTL: 10 minutes is the common OAuth2 spec recommendation and matches
// the AuthCodesTable's DynamoDB TTL.
const AUTH_CODE_TTL_SECONDS = 600;

// Bridge /pair must answer within this many ms during account-linking.
const PAIR_FETCH_TIMEOUT_MS = 5000;

// Bridge config. BRIDGE_URL is a non-secret env var; the dispatch secret is
// in SSM SecureString (same parameter the alexa-handler uses for /dispatch).
const BRIDGE_URL = process.env.BRIDGE_URL || '';
const BRIDGE_DISPATCH_SECRET_PARAM = process.env.BRIDGE_DISPATCH_SECRET_PARAM || '';

async function getBridgeDispatchSecret() {
  if (!BRIDGE_DISPATCH_SECRET_PARAM) return '';
  return getSecureParam(BRIDGE_DISPATCH_SECRET_PARAM);
}

// OAuth confidential-client credentials. These are the Client ID / Client
// Secret WE define on the skill's Account Linking page in the Alexa Developer
// Console; Alexa presents them back to /token on every grant. Stored in SSM
// SecureString (same pattern as the other secrets). The token endpoint fails
// CLOSED if these are unset — see verifyClientAuth.
const OAUTH_CLIENT_ID_PARAM = process.env.OAUTH_CLIENT_ID_PARAM || '';
const OAUTH_CLIENT_SECRET_PARAM = process.env.OAUTH_CLIENT_SECRET_PARAM || '';

async function getExpectedClientCreds() {
  if (!OAUTH_CLIENT_ID_PARAM || !OAUTH_CLIENT_SECRET_PARAM) {
    return { id: '', secret: '' };
  }
  const [id, secret] = await Promise.all([
    getSecureParam(OAUTH_CLIENT_ID_PARAM),
    getSecureParam(OAUTH_CLIENT_SECRET_PARAM),
  ]);
  return { id, secret };
}

// Pair-code shape. The plugin's daemon picks 10 chars from
// ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no I, O, 0, 1); see bin/src/pair-code.js
// and bridge/src/pair.js for the matching producer/consumer regexes.
const PAIR_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;

// Exact-host allowlist for the OAuth redirect_uri (open-redirect / auth-code
// exfiltration guard). Amazon documents EXACTLY these three hosts for Alexa
// account linking — there is no wildcard form, so we hard-match the full
// hostname and never pattern-match. The previous regex
// /(^|\.)amazon\.[a-z.]+$/ was anchored to a label, not a registrable
// suffix, so `amazon.evil.com` (and `*.amazon.<anything>`) passed it and an
// attacker could receive the one-time auth code.
//   pitangui.amazon.com   — North America
//   layla.amazon.com      — Europe / India
//   alexa.amazon.co.jp    — Far East / Japan
const ALLOWED_REDIRECT_HOSTS = new Set([
  'pitangui.amazon.com',
  'layla.amazon.com',
  'alexa.amazon.co.jp',
]);

// Access tokens have a 1h TTL, expressed in seconds for the OAuth response.
const ACCESS_TOKEN_TTL_SECONDS = 3600;

// Refresh-token rotation grace window. After we rotate the user's refresh
// token, the OLD one stays valid for this long so a concurrent / retried
// request from Alexa with the just-rotated token still succeeds. Without
// this, Alexa's natural retry/concurrency patterns can yank one of two
// near-simultaneous refresh requests into `invalid_grant`, which makes
// Alexa mark the skill broken and demand user re-link. 5 minutes covers
// the realistic retry window without keeping leaked tokens alive long.
const REFRESH_GRACE_MS = 5 * 60 * 1000;

// ---- Beta connection cap ----------------------------------------------------
//
// During the beta we cap the number of DISTINCT LoxBerry installations
// (bridgeUserId) that may link. The live limit lives in ConfigTable under
// this key so the operator can change it without a redeploy; until that item
// exists we fall back to BETA_MAX_CONNECTIONS_DEFAULT and lazily seed it.
const CONFIG_KEY_BETA_MAX = 'betaMaxConnections';

const BETA_MAX_CONNECTIONS_DEFAULT = (() => {
  const n = parseInt(process.env.BETA_MAX_CONNECTIONS_DEFAULT || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 100;
})();

// Read the live cap. Side effect: if the config item is absent, conditionally
// seed it with the env-var default so it materializes in DDB and is then
// operator-editable. The conditional write makes concurrent first-links
// idempotent (whoever loses the race just reads the value back next time).
async function getBetaMaxConnections() {
  if (!tableNames.config) return BETA_MAX_CONNECTIONS_DEFAULT;

  const res = await getDocClient().send(new GetCommand({
    TableName: tableNames.config,
    Key: { configKey: CONFIG_KEY_BETA_MAX },
  }));
  if (res.Item && Number.isFinite(res.Item.value)) {
    return res.Item.value;
  }

  try {
    await getDocClient().send(new PutCommand({
      TableName: tableNames.config,
      Item: {
        configKey: CONFIG_KEY_BETA_MAX,
        value: BETA_MAX_CONNECTIONS_DEFAULT,
        seededAt: new Date().toISOString(),
        note: 'Beta cap on distinct LoxBerry installations. Edit `value` to change.',
      },
      ConditionExpression: 'attribute_not_exists(configKey)',
    }));
    log.info('oauth.beta.config_seeded', { value: BETA_MAX_CONNECTIONS_DEFAULT });
  } catch (err) {
    // ConditionalCheckFailed = someone seeded it concurrently; not an error.
    if (err.name !== 'ConditionalCheckFailedException') {
      log.warn('oauth.beta.config_seed_failed', { error: err.message });
    }
  }
  return BETA_MAX_CONNECTIONS_DEFAULT;
}

// Set of distinct bridgeUserId values currently linked. Paginated full scan
// projecting only bridgeUserId — cheap at beta scale (≤ low hundreds of rows).
// This is the authoritative live count; DynamoDB's table ItemCount is
// eventually-consistent (~6h lag) and unusable for enforcement.
async function distinctBridgeInstalls() {
  const installs = new Set();
  let ExclusiveStartKey;
  do {
    const page = await getDocClient().send(new ScanCommand({
      TableName: tableNames.users,
      ProjectionExpression: 'bridgeUserId',
      ExclusiveStartKey,
    }));
    for (const item of page.Items || []) {
      if (item.bridgeUserId) installs.add(item.bridgeUserId);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return installs;
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

// Pure, side-effect-free helpers exposed for unit testing (no AWS calls).
// Not part of the Lambda contract — `handler` is the only runtime entry.
exports._test = {
  isValidCodeVerifier,
  pkceS256Challenge,
  verifyPkce,
  parseClientCredentials,
  timingSafeEqualStrings,
  isAllowedRedirectUri,
};

exports.handler = async (event, context) => {
  const requestId = event?.requestContext?.requestId || context.awsRequestId;
  const method = event?.requestContext?.http?.method;
  const path = event?.requestContext?.http?.path;

  // DEBUG: at scale `/event` fires for every ChangeReport (potentially many
  // per second across all paired users). Lifecycle paths (`/authorize`,
  // `/token`) are rare per user and are logged at INFO inside their own
  // handlers when meaningful events happen. Errors below are at WARN/ERROR.
  log.debug('oauth.request', { requestId, method, path });

  try {
    if (path === '/authorize' && method === 'GET') return await handleAuthorizeGet(event);
    if (path === '/authorize' && method === 'POST') return await handleAuthorizePost(event);
    if (path === '/token' && method === 'POST') return await handleToken(event);
    if (path === '/event' && method === 'POST') return await handleEvent(event);

    return jsonResponse(404, { error: 'not_found' });
  } catch (err) {
    log.error('oauth.unhandled', { requestId, error: err.message, stack: err.stack });
    return jsonResponse(500, { error: 'server_error' });
  }
};

// -----------------------------------------------------------------------------
// GET /authorize — render the registration form
// -----------------------------------------------------------------------------

async function handleAuthorizeGet(event) {
  const params = event.queryStringParameters || {};
  const {
    response_type, client_id, redirect_uri, state, scope,
    code_challenge, code_challenge_method,
  } = params;

  if (response_type !== 'code') {
    return errorRedirect(redirect_uri, state, 'unsupported_response_type');
  }
  if (!redirect_uri || !isAllowedRedirectUri(redirect_uri)) {
    // Cannot redirect — the redirect_uri itself is invalid. Render an error page.
    return htmlResponse(400, renderErrorPage('Invalid or untrusted redirect_uri.'));
  }
  if (!state) {
    return errorRedirect(redirect_uri, '', 'invalid_request');
  }
  // If PKCE is in play, we only accept S256. Reject `plain`/unknown up
  // front (per RFC 7636 §4.3) rather than silently downgrading.
  if (code_challenge && code_challenge_method && code_challenge_method !== 'S256') {
    return errorRedirect(redirect_uri, state, 'invalid_request');
  }

  return htmlResponse(200, renderAuthorizeForm({
    redirect_uri, state, client_id, scope,
    code_challenge: code_challenge || '',
    code_challenge_method: code_challenge ? 'S256' : '',
  }));
}

// -----------------------------------------------------------------------------
// POST /authorize — verify Loxberry, mint authcode, redirect back to Alexa
// -----------------------------------------------------------------------------

async function handleAuthorizePost(event) {
  const form = parseFormBody(event);
  const { friendlyName, redirect_uri, state } = form;
  const clientId = form.client_id || '';
  const codeChallenge = form.code_challenge || '';
  const codeChallengeMethod = codeChallenge ? 'S256' : '';
  // Carried into every error re-render so a user retry (bad pair code etc.)
  // doesn't silently drop the PKCE binding or client_id.
  const carry = {
    redirect_uri, state, client_id: clientId, scope: form.scope || '',
    code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod,
  };
  // Normalize: trim and uppercase. The form's JS already uppercases on input,
  // but a paste from somewhere weird or a no-JS submission should still work.
  const pairCode = (form.pairCode || '').trim().toUpperCase();

  if (!redirect_uri || !isAllowedRedirectUri(redirect_uri)) {
    return htmlResponse(400, renderErrorPage('Invalid or untrusted redirect_uri.'));
  }
  if (!state) {
    return errorRedirect(redirect_uri, '', 'invalid_request');
  }
  // Defense in depth: a forged POST could carry a non-S256 method even
  // though GET rejects it. Refuse rather than store a weak binding.
  if (codeChallenge && form.code_challenge_method && form.code_challenge_method !== 'S256') {
    return errorRedirect(redirect_uri, state, 'invalid_request');
  }
  if (!pairCode) {
    return htmlResponse(400, renderAuthorizeForm({
      ...carry,
      error: 'A pair code is required. Generate one in the Aloxberry plugin\'s web UI.',
      values: { ...form, pairCode },
    }));
  }
  if (!PAIR_CODE_PATTERN.test(pairCode)) {
    return htmlResponse(400, renderAuthorizeForm({
      ...carry,
      error: 'Pair code must be exactly 10 characters from the set ' +
             'A-Z (no I, O) and 2-9. Check for typos and try again.',
      values: { ...form, pairCode },
    }));
  }

  // Redeem the pair code at the bridge. The bridge returns {userId, skillSecret}
  // and *deletes* the entry on read, so codes are truly one-shot. If the daemon
  // has not yet published this code (or its publication has already expired or
  // been consumed by an earlier link), we get a 404.
  let bridgeSecret;
  try { bridgeSecret = await getBridgeDispatchSecret(); }
  catch (err) {
    log.error('oauth.bridge.ssm_failed', { error: err.message });
    return htmlResponse(500, renderErrorPage('Server configuration error — please retry shortly.'));
  }
  if (!BRIDGE_URL || !bridgeSecret) {
    log.error('oauth.bridge.unconfigured', {
      hasBridgeUrl: !!BRIDGE_URL, hasBridgeSecret: !!bridgeSecret,
    });
    return htmlResponse(500, renderErrorPage('Bridge is not configured. Contact the operator.'));
  }

  const redeemed = await redeemPairCode(pairCode, bridgeSecret);
  if (!redeemed.ok) {
    log.warn('oauth.pair.redeem_failed', { reason: redeemed.reason, status: redeemed.status });
    return htmlResponse(400, renderAuthorizeForm({
      ...carry,
      error: redeemed.userMessage,
      values: { ...form, pairCode: '' }, // clear the bad/used code so the user doesn't retry it
    }));
  }
  log.info('oauth.pair.redeemed', { bridgeUserId: redeemed.userId });

  // ---- Beta connection cap ------------------------------------------------
  // Enforced here (after redemption) because we need the bridgeUserId to tell
  // a brand-new installation from one that's already in the beta — and the
  // bridge deletes the pair code on read, so there's no way to peek first. An
  // already-linked install is never blocked (it may add more Alexa accounts);
  // only a NEW install is refused once the distinct count hits the cap. If the
  // cap check itself fails (DDB error), we fail OPEN — a monitoring blip must
  // not lock everyone out of linking.
  try {
    const [limit, installs] = await Promise.all([
      getBetaMaxConnections(),
      distinctBridgeInstalls(),
    ]);
    const alreadyLinked = installs.has(redeemed.userId);
    if (!alreadyLinked && installs.size >= limit) {
      log.warn('oauth.beta.cap_reached', {
        limit,
        distinctInstalls: installs.size,
        bridgeUserId: redeemed.userId,
      });
      return htmlResponse(403, renderBetaFullPage(limit));
    }
    log.info('oauth.beta.cap_ok', {
      limit,
      distinctInstalls: installs.size,
      alreadyLinked,
    });
  } catch (err) {
    log.error('oauth.beta.cap_check_failed', { error: err.message });
    // Fail open: continue with the link.
  }

  // Persist user.
  const userId = randomUUID();
  const refreshToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();

  await getDocClient().send(new PutCommand({
    TableName: tableNames.users,
    Item: {
      userId,
      bridgeUserId: redeemed.userId,
      skillSecret: redeemed.skillSecret,
      refreshToken,
      friendlyName: friendlyName || null,
      createdAt: now,
      updatedAt: now,
    },
    ConditionExpression: 'attribute_not_exists(userId)',
  }));

  // Mint an auth code.
  const code = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS;

  await getDocClient().send(new PutCommand({
    TableName: tableNames.authCodes,
    Item: {
      code,
      userId,
      redirectUri: redirect_uri,
      createdAt: now,
      ttl: expiresAt,
      // PKCE binding (RFC 7636) — present only if Alexa initiated PKCE.
      // exchangeAuthCode enforces the verifier iff codeChallenge is set.
      ...(codeChallenge ? {
        codeChallenge,
        codeChallengeMethod: codeChallengeMethod || 'S256',
      } : {}),
      // Client binding (RFC 6749 §4.1.3) — the same authenticated client
      // must redeem the code. Stored only if a client_id came through.
      ...(clientId ? { clientId } : {}),
    },
  }));

  log.info('oauth.user.registered', { userId });

  const target = new URL(redirect_uri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', state);
  return redirectResponse(target.toString());
}

// -----------------------------------------------------------------------------
// POST /token — exchange auth code (or refresh token) for access token
// -----------------------------------------------------------------------------

async function handleToken(event) {
  const form = parseFormBody(event);
  const grantType = form.grant_type;
  const contentType =
    (event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '';

  log.info('oauth.token.received', {
    grantType: grantType || '(missing)',
    contentType,
    hasCode: !!form.code,
    hasRefreshToken: !!form.refresh_token,
    hasRedirectUri: !!form.redirect_uri,
    hasAuthHeader: !!(event.headers && (event.headers.authorization || event.headers.Authorization)),
    formKeys: Object.keys(form),
  });

  // RFC 6749 §2.3 / §3.2.1: confidential clients authenticate on EVERY
  // token request, before any grant-specific processing.
  const authFail = await verifyClientAuth(event, form);
  if (authFail) return authFail;
  const authedClientId = parseClientCredentials(event, form).id;

  if (grantType === 'authorization_code') {
    return await exchangeAuthCode(form, authedClientId);
  }
  if (grantType === 'refresh_token') {
    return await exchangeRefreshToken(form);
  }
  log.warn('oauth.token.unsupported_grant', { grantType });
  return jsonResponse(400, { error: 'unsupported_grant_type' });
}

async function exchangeAuthCode(form, authedClientId) {
  const { code, redirect_uri } = form;
  if (!code) {
    log.warn('oauth.token.code_missing');
    return jsonResponse(400, { error: 'invalid_request', error_description: 'code missing' });
  }

  const codeRow = await getDocClient().send(new GetCommand({
    TableName: tableNames.authCodes,
    Key: { code },
  }));
  if (!codeRow.Item) {
    log.warn('oauth.token.code_not_found', { code });
    return jsonResponse(400, { error: 'invalid_grant', error_description: 'unknown or expired code' });
  }

  const item = codeRow.Item;
  // Defensive expiry check (DynamoDB TTL has up to 48h delete latency).
  if (typeof item.ttl === 'number' && item.ttl < Math.floor(Date.now() / 1000)) {
    log.warn('oauth.token.code_expired', { code, ttl: item.ttl, now: Math.floor(Date.now() / 1000) });
    await deleteAuthCode(code).catch(() => {});
    return jsonResponse(400, { error: 'invalid_grant', error_description: 'code expired' });
  }
  if (redirect_uri && item.redirectUri && redirect_uri !== item.redirectUri) {
    log.warn('oauth.token.redirect_mismatch', {
      code,
      submittedRedirect: redirect_uri,
      storedRedirect: item.redirectUri,
    });
    return jsonResponse(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  // Auth-code → client binding (RFC 6749 §4.1.3). If we recorded the
  // client_id at /authorize, the same authenticated client must redeem it.
  if (item.clientId && item.clientId !== authedClientId) {
    log.warn('oauth.token.client_binding_mismatch', { code });
    await deleteAuthCode(code).catch(() => {});
    return jsonResponse(400, { error: 'invalid_grant', error_description: 'code not issued to this client' });
  }

  // PKCE (RFC 7636). Enforced iff a challenge was stored at /authorize.
  const pkce = verifyPkce({
    storedChallenge: item.codeChallenge,
    storedMethod:    item.codeChallengeMethod,
    codeVerifier:    form.code_verifier,
  });
  if (!pkce.ok) {
    log.warn('oauth.token.pkce_failed', { code, desc: pkce.desc });
    // Invalidate the code on a failed verifier check — stops an
    // intercepted code from being brute-forced against the challenge.
    await deleteAuthCode(code).catch(() => {});
    return jsonResponse(400, { error: pkce.error, error_description: pkce.desc });
  }

  // One-time use: delete the code immediately.
  await deleteAuthCode(code);

  const userRow = await getDocClient().send(new GetCommand({
    TableName: tableNames.users,
    Key: { userId: item.userId },
  }));
  if (!userRow.Item) {
    log.error('oauth.token.user_missing', { userId: item.userId });
    return jsonResponse(400, { error: 'invalid_grant' });
  }

  const accessToken = await signAccessToken({ userId: item.userId });

  log.info('oauth.token.issued', { userId: item.userId, grant: 'authorization_code' });

  return jsonResponse(200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: userRow.Item.refreshToken,
  });
}

async function exchangeRefreshToken(form) {
  const { refresh_token } = form;
  if (!refresh_token) return jsonResponse(400, { error: 'invalid_request' });

  // Look up the user. Match against EITHER the current refreshToken OR a
  // recently-rotated prevRefreshToken (within the grace window). Refresh
  // tokens are opaque, so we scan; a GSI on each field is the proper Phase-4
  // optimization.
  const scan = await getDocClient().send(new ScanCommand({
    TableName: tableNames.users,
    FilterExpression: 'refreshToken = :rt OR prevRefreshToken = :rt',
    ExpressionAttributeValues: { ':rt': refresh_token },
    Limit: 1,
  }));
  const user = scan.Items && scan.Items[0];
  if (!user) {
    log.warn('oauth.refresh.not_found', { tokenPrefix: refresh_token.slice(0, 8) });
    return jsonResponse(400, { error: 'invalid_grant' });
  }

  const now = Date.now();
  const matchedPrev = (user.prevRefreshToken === refresh_token);

  // Grace path: the submitted token matches the JUST-ROTATED token. Don't
  // rotate again — return the CURRENT refresh token + a fresh access token.
  // Makes Alexa's retry / concurrent refresh attempts idempotent.
  if (matchedPrev) {
    const expiresAt = Date.parse(user.prevRefreshExpiresAt || '');
    if (!Number.isFinite(expiresAt) || expiresAt < now) {
      log.warn('oauth.refresh.prev_expired', {
        userId: user.userId,
        prevExpiresAt: user.prevRefreshExpiresAt,
      });
      return jsonResponse(400, { error: 'invalid_grant' });
    }
    // DEBUG: token refresh fires periodically per user (~hourly per Alexa).
    // At scale this is high-volume but successful refreshes carry no operator
    // signal — only refresh failures (logged at WARN above) need attention.
    log.debug('oauth.refresh.grace_served', { userId: user.userId });
    const accessToken = await signAccessToken({ userId: user.userId });
    return jsonResponse(200, {
      access_token:  accessToken,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: user.refreshToken,   // already-rotated current value
    });
  }

  // Primary path: rotate the token. Move current → prev (with TTL), assign
  // a fresh token. ConditionExpression guards against a concurrent rotation.
  const newRefresh = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const prevExpiresAt = new Date(now + REFRESH_GRACE_MS).toISOString();
  try {
    await getDocClient().send(new UpdateCommand({
      TableName: tableNames.users,
      Key: { userId: user.userId },
      UpdateExpression:
        'SET refreshToken = :new, ' +
        '    prevRefreshToken = :old, ' +
        '    prevRefreshExpiresAt = :exp, ' +
        '    updatedAt = :now',
      ConditionExpression: 'refreshToken = :old',
      ExpressionAttributeValues: {
        ':new': newRefresh,
        ':old': refresh_token,
        ':exp': prevExpiresAt,
        ':now': new Date(now).toISOString(),
      },
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Another request rotated first. The current token field has moved
      // forward; ours is now (hopefully) in prevRefreshToken. Re-fetch and
      // serve via the grace path. This is the racing-Alexa-refresh case.
      const refetch = await getDocClient().send(new GetCommand({
        TableName: tableNames.users,
        Key: { userId: user.userId },
      }));
      const fresh = refetch.Item;
      if (!fresh || fresh.prevRefreshToken !== refresh_token) {
        log.warn('oauth.refresh.cce_no_prev_match', { userId: user.userId });
        return jsonResponse(400, { error: 'invalid_grant' });
      }
      const expiresAt = Date.parse(fresh.prevRefreshExpiresAt || '');
      if (!Number.isFinite(expiresAt) || expiresAt < now) {
        log.warn('oauth.refresh.cce_prev_expired', { userId: user.userId });
        return jsonResponse(400, { error: 'invalid_grant' });
      }
      log.debug('oauth.refresh.race_resolved', { userId: user.userId });
      const accessToken = await signAccessToken({ userId: user.userId });
      return jsonResponse(200, {
        access_token:  accessToken,
        token_type:    'Bearer',
        expires_in:    ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: fresh.refreshToken,
      });
    }
    throw err;
  }

  log.debug('oauth.refresh.rotated', { userId: user.userId });
  const accessToken = await signAccessToken({ userId: user.userId });
  return jsonResponse(200, {
    access_token:  accessToken,
    token_type:    'Bearer',
    expires_in:    ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newRefresh,
  });
}

async function deleteAuthCode(code) {
  await getDocClient().send(new DeleteCommand({
    TableName: tableNames.authCodes,
    Key: { code },
  }));
}

// -----------------------------------------------------------------------------
// POST /event — Phase 4 outbound: bridge → Lambda → Alexa Event Gateway
// -----------------------------------------------------------------------------
//
// The bridge POSTs daemon-originated ChangeReports here. The bridge sees only
// the outer envelope (it doesn't inspect the body); the body is end-to-end
// HMAC-signed between daemon and Lambda using the per-pairing `skillSecret`.
// Symmetric with the inbound /dispatch direction.
//
// Request:
//   POST /event
//   Headers:
//     x-bridge-auth        : BRIDGE_DISPATCH_SECRET (bridge-level auth)
//     x-aloxberry-timestamp  : daemon HMAC timestamp
//     x-aloxberry-signature  : daemon HMAC over `${timestamp}\n${body}`
//     content-type         : application/json
//   Body:
//     { bridgeUserId, changeReport }   — the daemon's canonical JSON
//
// One daemon event fans out to all DDB users sharing that bridgeUserId
// (multi-Alexa-account scenarios). Each user gets a fresh LWA access
// token minted from their stored refresh-token, then their copy of the
// ChangeReport gets POSTed to Alexa's Event Gateway with that token.

async function handleEvent(event) {
  const requestId = event?.requestContext?.requestId;

  // ---- 1. Bridge-level auth -------------------------------------------------
  const bridgeAuth = headerValue(event, 'x-bridge-auth') || '';
  const bridgeSecret = await getBridgeDispatchSecret();
  if (!bridgeSecret) {
    log.error('event.no_bridge_secret', { requestId });
    return jsonResponse(503, { error: 'bridge_dispatch_secret_unconfigured' });
  }
  if (!timingSafeEqualStrings(bridgeAuth, bridgeSecret)) {
    log.warn('event.bridge_auth_failed', { requestId });
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // ---- 2. Parse body -------------------------------------------------------
  // Keep the raw bytes for HMAC verification: re-serializing later would
  // change key order/whitespace and break the signature.
  const rawBody = bodyAsString(event);
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    log.warn('event.body_not_json', { requestId });
    return jsonResponse(400, { error: 'invalid_body' });
  }
  if (!body || typeof body.bridgeUserId !== 'string' || !body.changeReport) {
    log.warn('event.body_malformed', { requestId, keys: body ? Object.keys(body) : null });
    return jsonResponse(400, { error: 'invalid_body' });
  }

  // ---- 3. Look up users sharing this bridgeUserId --------------------------
  // Many Alexa accounts can pair against the same daemon — they all share
  // the bridgeUserId + skillSecret but have their own lwaRefreshToken. The
  // scan filter is short-lived (handful of users in practice); a GSI is a
  // Phase-5 optimization if this ever grows.
  const scan = await getDocClient().send(new ScanCommand({
    TableName: tableNames.users,
    FilterExpression: 'bridgeUserId = :bu',
    ExpressionAttributeValues: { ':bu': body.bridgeUserId },
  }));
  const users = (scan.Items || []).filter((u) => u.skillSecret && u.lwaRefreshToken);
  if (users.length === 0) {
    log.warn('event.no_matching_users', { requestId, bridgeUserId: body.bridgeUserId.slice(0, 8) });
    // Return 200 so the bridge doesn't retry — there's literally no recipient.
    return jsonResponse(200, { delivered: 0, reason: 'no_users' });
  }

  // ---- 4. Verify daemon HMAC ----------------------------------------------
  // skillSecret is shared across all users with the same bridgeUserId (set
  // at pair time, never rotated by linking another account), so any user
  // row's secret will do.
  const timestamp = headerValue(event, HEADER_ALOXBERRY_TIMESTAMP);
  const signature = headerValue(event, HEADER_ALOXBERRY_SIGNATURE);
  const skillSecretHex = users[0].skillSecret;
  const skillSecretBytes = Buffer.from(skillSecretHex, 'hex');
  const hmacOk = verifyRequest({
    secret:    skillSecretBytes,
    body:      rawBody,
    timestamp,
    signature,
  });
  if (!hmacOk) {
    log.warn('event.hmac_failed', { requestId, bridgeUserId: body.bridgeUserId.slice(0, 8) });
    // Forged / replayed / clock-skewed. 401 — bridge will log + drop.
    return jsonResponse(401, { error: 'invalid_signature' });
  }

  // ---- 5. Fan out: one Event-Gateway POST per user ------------------------
  // Two distinct fetches happen per user — LWA refresh, then the Event
  // Gateway POST. Log them separately so failures are actionable: Node's
  // `fetch()` flattens DNS errors, connection resets, TLS failures, and
  // aborts to the same opaque "fetch failed" message; the real cause is
  // in `err.cause` (a SystemError or AbortError). We surface both.
  let delivered = 0;
  let failed    = 0;
  for (const user of users) {
    // ---- 5a. Mint a fresh LWA access token --------------------------------
    let accessToken;
    try {
      accessToken = await refreshLwaAccessToken(user.lwaRefreshToken);
    } catch (err) {
      failed++;
      log.error('event.lwa_refresh_failed', {
        requestId,
        userId: user.userId,
        error:  err.message,
        // err.cause is where Node's undici stashes the underlying
        // SystemError (DNS, ECONNRESET, etc.) or AbortError.
        cause:  err.cause?.message || err.cause?.code || err.cause?.errno || null,
        causeType: err.cause?.name || null,
      });
      continue;
    }

    // ---- 5b. POST the ChangeReport to Alexa's Event Gateway ---------------
    // Stamp the per-user access token into the envelope (daemon left a
    // placeholder 'LAMBDA_FILLS_IN' there).
    const cr = body.changeReport;
    if (cr?.event?.endpoint?.scope) {
      cr.event.endpoint.scope.token = accessToken;
    }

    try {
      const res = await postToEventGateway(cr);
      if (res.ok) {
        delivered++;
        // DEBUG: per-recipient success — fires for every ChangeReport
        // fanout × number of paired users. Failures (next branch) stay
        // at WARN so they remain visible.
        log.debug('event.delivered', {
          requestId,
          userId: user.userId,
          endpointId: cr?.event?.endpoint?.endpointId,
        });
      } else {
        failed++;
        log.warn('event.gateway_non2xx', {
          requestId,
          userId: user.userId,
          status: res.status,
          body:   res.body,
        });
      }
    } catch (err) {
      failed++;
      log.error('event.gateway_fetch_failed', {
        requestId,
        userId: user.userId,
        error:  err.message,
        cause:  err.cause?.message || err.cause?.code || err.cause?.errno || null,
        causeType: err.cause?.name || null,
      });
    }
  }

  // DEBUG normally — one line per ChangeReport. Auto-elevates to WARN when
  // ANY recipient failed, since "delivered=3 failed=1" is a real operator
  // signal worth seeing without flipping LOG_LEVEL=DEBUG.
  const fanoutFields = {
    requestId,
    bridgeUserId: body.bridgeUserId.slice(0, 8),
    delivered,
    failed,
  };
  if (failed > 0) log.warn('event.fanout_partial_failure', fanoutFields);
  else            log.debug('event.fanout_complete', fanoutFields);
  // Return 2xx even with partial failure — the bridge has no useful retry
  // policy for state events (the next state change will overwrite this one).
  return jsonResponse(200, { delivered, failed });
}

// Headers from API Gateway HTTP API arrive lower-cased in event.headers.
function headerValue(event, name) {
  const headers = event?.headers || {};
  return headers[name] || headers[name.toLowerCase()] || '';
}

// API Gateway HTTP API may base64-encode the body if isBase64Encoded=true.
// We need the exact bytes the daemon signed — decode if needed.
function bodyAsString(event) {
  if (!event || typeof event.body !== 'string') return '';
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body;
}

// Constant-time string compare. Used for the bridge-auth check above so
// we don't leak prefix-matches by short-circuiting.
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// -----------------------------------------------------------------------------
// Pair-code redemption
// -----------------------------------------------------------------------------
//
// Ask the bridge to hand over (and delete) the daemon's published entry for
// this code. Bridge contract (bridge/src/http-handlers.js):
//   GET /pair?code=<10-char-code>
//   X-Bridge-Auth: BRIDGE_DISPATCH_SECRET
//     → 200 { userId, skillSecret }   ← entry deleted on read
//     → 404 { error: "not_found" }    ← unknown, expired, or already redeemed
//     → 400 { error: "invalid_code" } ← shape rejected (we pre-validate, but
//                                       this catches alphabet drift)
//     → 401 { error: "unauthorized" } ← BRIDGE_DISPATCH_SECRET mismatch
//     → 503 { error: "not_configured" }
//
// Returns either {ok:true, userId, skillSecret} or {ok:false, reason, status,
// userMessage}. The userMessage is what gets rendered to the user — actionable
// text without leaking bridge internals.

async function redeemPairCode(code, bridgeSecret) {
  const url = `${BRIDGE_URL}/pair?code=${encodeURIComponent(code)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PAIR_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-bridge-auth': bridgeSecret,
        'user-agent': 'aloxberry-oauth-handler/0.1',
      },
      signal: ac.signal,
    });
    if (res.status === 200) {
      const body = await res.json().catch(() => null);
      if (!body || typeof body.userId !== 'string' || typeof body.skillSecret !== 'string') {
        return {
          ok: false, status: 200, reason: 'malformed_body',
          userMessage: 'Bridge returned an unexpected response. Try again or contact the operator.',
        };
      }
      return { ok: true, userId: body.userId, skillSecret: body.skillSecret };
    }
    if (res.status === 404) {
      return {
        ok: false, status: 404, reason: 'not_found',
        userMessage:
          'That code is not recognized. It may have expired (codes last 10 minutes), ' +
          'already been used, or never been generated. Go back to the Aloxberry plugin\'s ' +
          'web UI, generate a fresh code, and paste it here.',
      };
    }
    if (res.status === 401) {
      return {
        ok: false, status: 401, reason: 'unauthorized',
        userMessage: 'Bridge configuration error (auth failed). Please contact the operator.',
      };
    }
    if (res.status === 503) {
      return {
        ok: false, status: 503, reason: 'bridge_not_configured',
        userMessage: 'Bridge is not yet configured. Please try again later.',
      };
    }
    return {
      ok: false, status: res.status, reason: `http_${res.status}`,
      userMessage: `Bridge returned an unexpected HTTP ${res.status}. Try again shortly.`,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        ok: false, reason: 'timeout',
        userMessage: `Bridge did not respond within ${PAIR_FETCH_TIMEOUT_MS}ms. Try again.`,
      };
    }
    return {
      ok: false, reason: err.message,
      userMessage: `Could not reach the bridge: ${err.message}. Try again in a minute.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// ---- PKCE (RFC 7636) --------------------------------------------------------
//
// We only support S256 (Alexa always sends it; `plain` defeats the purpose
// since the challenge == verifier in transit). Enforcement is a SERVER-SIDE
// decision keyed off the challenge we stored at /authorize: a stolen code
// can't strip it, because the token request never gets to choose whether
// PKCE applies — the stored row does. That makes this non-downgradeable.

// RFC 7636 §4.1: verifier is 43–128 chars from the unreserved set.
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function isValidCodeVerifier(v) {
  return typeof v === 'string' && CODE_VERIFIER_RE.test(v);
}

// base64url( SHA256( ASCII(verifier) ) ), no padding — RFC 7636 §4.6.
function pkceS256Challenge(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// Decide whether a token request satisfies the PKCE binding recorded on the
// auth-code row. Returns { ok:true } or { ok:false, error, desc }.
//   - no stored challenge        → PKCE wasn't used at /authorize; pass
//     (client-secret auth still applies independently)
//   - stored challenge present   → verifier REQUIRED, must be valid, must
//     hash to the stored challenge (constant-time compare)
function verifyPkce({ storedChallenge, storedMethod, codeVerifier }) {
  if (!storedChallenge) return { ok: true };
  if (storedMethod && storedMethod !== 'S256') {
    return { ok: false, error: 'invalid_grant', desc: 'unsupported code_challenge_method' };
  }
  if (!codeVerifier) {
    return { ok: false, error: 'invalid_grant', desc: 'code_verifier required' };
  }
  if (!isValidCodeVerifier(codeVerifier)) {
    return { ok: false, error: 'invalid_grant', desc: 'malformed code_verifier' };
  }
  const computed = pkceS256Challenge(codeVerifier);
  if (!timingSafeEqualStrings(computed, storedChallenge)) {
    return { ok: false, error: 'invalid_grant', desc: 'code_verifier mismatch' };
  }
  return { ok: true };
}

// ---- Token-endpoint client authentication (RFC 6749 §2.3) -------------------
//
// Alexa is a confidential client and authenticates on EVERY token request
// (both authorization_code and refresh_token). Two transport schemes are
// permitted by the spec and selectable in the skill's Account Linking config:
//   - HTTP Basic:  Authorization: Basic base64(urlencode(id):urlencode(secret))
//   - Request body: client_id / client_secret form fields
// We accept either. Basic wins if both are present (RFC 6749 §2.3.1 SHOULD).

function parseClientCredentials(event, form) {
  const auth = headerValue(event, 'authorization');
  if (auth && /^Basic\s+/i.test(auth)) {
    try {
      const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx >= 0) {
        // Per §2.3.1 the two halves are application/x-www-form-urlencoded.
        const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
        return {
          id: dec(decoded.slice(0, idx)),
          secret: dec(decoded.slice(idx + 1)),
          source: 'basic',
        };
      }
    } catch { /* fall through to body creds */ }
  }
  if (form && (form.client_id || form.client_secret)) {
    return { id: form.client_id || '', secret: form.client_secret || '', source: 'body' };
  }
  return { id: '', secret: '', source: 'none' };
}

// Enforce client authentication on the token endpoint. Returns null when
// the caller is authenticated, or a ready-to-return error response.
// FAILS CLOSED: if the expected credentials aren't configured in SSM the
// endpoint refuses all token requests (503) rather than silently accepting
// any client — "do it right" over "stay convenient".
async function verifyClientAuth(event, form) {
  let expected;
  try {
    expected = await getExpectedClientCreds();
  } catch (err) {
    log.error('oauth.client.ssm_failed', { error: err.message });
    return jsonResponse(503, { error: 'temporarily_unavailable' });
  }
  if (!expected.id || !expected.secret) {
    log.error('oauth.client.unconfigured', {
      hasIdParam: !!OAUTH_CLIENT_ID_PARAM,
      hasSecretParam: !!OAUTH_CLIENT_SECRET_PARAM,
    });
    return jsonResponse(503, { error: 'temporarily_unavailable' });
  }
  const creds = parseClientCredentials(event, form);
  const idOk = timingSafeEqualStrings(creds.id, expected.id);
  const secretOk = timingSafeEqualStrings(creds.secret, expected.secret);
  if (!idOk || !secretOk) {
    log.warn('oauth.client.auth_failed', {
      source: creds.source,
      idPresent: !!creds.id,
      secretPresent: !!creds.secret,
    });
    // RFC 6749 §5.2: invalid_client → 401.
    return jsonResponse(401, { error: 'invalid_client' });
  }
  return null;
}

function isAllowedRedirectUri(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'https:') return false;
    // URL.hostname is already normalized (lowercased, no port); exact
    // membership only — no substring/regex, so no host-spoof bypass.
    return ALLOWED_REDIRECT_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function parseFormBody(event) {
  const ct = (event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '';
  let body = event.body || '';
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');

  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    return Object.fromEntries(params.entries());
  }
  if (ct.includes('application/json')) {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return {};
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function htmlResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body,
  };
}

function redirectResponse(location) {
  return {
    statusCode: 302,
    headers: { location, 'cache-control': 'no-store' },
    body: '',
  };
}

function errorRedirect(redirectUri, state, errorCode) {
  if (!redirectUri || !isAllowedRedirectUri(redirectUri)) {
    return htmlResponse(400, renderErrorPage(`OAuth error: ${errorCode}`));
  }
  const u = new URL(redirectUri);
  u.searchParams.set('error', errorCode);
  if (state) u.searchParams.set('state', state);
  return redirectResponse(u.toString());
}

// -----------------------------------------------------------------------------
// HTML templates
// -----------------------------------------------------------------------------

function renderAuthorizeForm({
  redirect_uri, state, client_id = '', scope = '',
  code_challenge = '', code_challenge_method = '',
  error = '', values = {},
}) {
  const v = (k) => escapeHtml(values[k] || '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Aloxberry to Alexa</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 520px; margin: 2.5rem auto; padding: 0 1rem; line-height: 1.45; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
    p.lead { color: #555; margin-top: 0; }
    label { display: block; margin-top: 1rem; font-weight: 600; font-size: 0.9rem; }
    input[type=text] {
      width: 100%; box-sizing: border-box; padding: 0.55rem 0.65rem;
      font-size: 0.95rem; border: 1px solid #aaa; border-radius: 6px;
    }
    input#pairCode {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.15em; text-align: center; font-size: 1.25rem;
      text-transform: uppercase;
    }
    button { margin-top: 1.5rem; padding: 0.65rem 1.1rem; font-size: 1rem;
             background: #0d7; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
    button:hover { background: #0b6; }
    .err { background: #fee; border: 1px solid #c44; color: #800;
           padding: 0.75rem; border-radius: 6px; margin-top: 1rem; }
    .hint { color: #777; font-size: 0.85rem; margin-top: 0.25rem; }
    code { background: #f3f3f3; padding: 0.05rem 0.3rem; border-radius: 3px; }
    ol { padding-left: 1.2rem; }
    ol li { margin: 0.25rem 0; }
  </style>
</head>
<body>
  <h1>Link your Aloxberry plugin to Alexa</h1>
  <p class="lead">
    To link, enter the <strong>10-character pair code</strong> from the
    Aloxberry plugin's web UI. The code is one-shot and expires after 10 minutes.
  </p>
  <ol>
    <li>Open your LoxBerry → Plugins → Aloxberry.</li>
    <li>Click <em>Show pair code</em>.</li>
    <li>Type or paste the 10 characters below.</li>
  </ol>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/authorize" autocomplete="off">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
    <input type="hidden" name="scope" value="${escapeHtml(scope)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}">

    <label for="pairCode">Pair code</label>
    <input id="pairCode" type="text" name="pairCode" required
           minlength="10" maxlength="10"
           pattern="[A-HJ-NP-Z2-9]{10}"
           autocapitalize="characters"
           spellcheck="false"
           inputmode="text"
           placeholder="ABCDEFGHJK"
           oninput="this.value=this.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '')"
           value="${v('pairCode')}">
    <div class="hint">
      10 characters: A-Z (no I, O) and 2-9. Lowercase is converted automatically.
    </div>

    <label for="friendlyName">Friendly name (optional)</label>
    <input id="friendlyName" type="text" name="friendlyName"
           placeholder="Home" value="${v('friendlyName')}">
    <div class="hint">Shown in the Alexa app to help you tell linked homes apart.</div>

    <button type="submit">Link this Aloxberry</button>
  </form>
</body>
</html>`;
}

// Shown when the beta cap is reached and this is a NEW installation. Kept
// deliberately warm and non-technical — the person sees this mid-link in the
// Alexa app. The forum link is a placeholder until the forum thread exists;
// swap FORUM_URL in (and flip the surrounding block) once it's live.
function renderBetaFullPage(limit) {
  const FORUM_URL = ''; // TODO: point at the "request a beta slot" forum thread
  const forumBlock = FORUM_URL
    ? `<p>Want in sooner? You can ask for an additional slot here:</p>
       <p><a href="${escapeHtml(FORUM_URL)}">${escapeHtml(FORUM_URL)}</a></p>`
    : `<p>A place to request an additional slot is coming soon — please check
       back, or watch the Aloxberry plugin announcements.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aloxberry beta is full</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 520px; margin: 2.5rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.35rem; }
    p { color: #444; }
    .box { background: #eef4ff; border: 1px solid #9bb8e8; color: #1a3a6b;
           padding: 1rem; border-radius: 8px; }
    a { color: #1a5ad0; }
  </style>
</head>
<body>
  <h1>The Aloxberry beta is currently full 🚧</h1>
  <div class="box">
    <p>
      Thanks for your interest! Aloxberry is still in a limited beta, capped at
      <strong>${escapeHtml(String(limit))}</strong> connected LoxBerry
      installations so we can keep an eye on stability. That limit is reached
      right now, so we can't link a new installation just yet.
    </p>
    ${forumBlock}
    <p>
      If you have <em>already</em> linked this LoxBerry before, adding another
      Alexa account to it still works — this message only appears for brand-new
      installations.
    </p>
  </div>
</body>
</html>`;
}

function renderErrorPage(message) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Error</title></head>
<body style="font-family: sans-serif; max-width: 480px; margin: 3rem auto; padding: 0 1rem;">
  <h1>Something went wrong</h1>
  <p>${escapeHtml(message)}</p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
