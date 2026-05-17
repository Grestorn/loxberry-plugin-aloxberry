'use strict';

const { randomUUID } = require('crypto');
const { Buffer } = require('buffer');
const { GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const {
  getDocClient,
  tableNames,
  verifyAccessToken,
  signAloxberryRequest,
  getSecureParam,
  HEADER_ALOXBERRY_TIMESTAMP,
  HEADER_ALOXBERRY_SIGNATURE,
  log,
} = require('@aloxberry/shared');

// Bridge config. BRIDGE_URL is a non-secret env var. The dispatch secret is
// read from SSM SecureString (same pattern as JWT_SECRET_PARAM) and cached
// across warm invocations by getSecureParam.
const BRIDGE_URL = process.env.BRIDGE_URL || '';
const BRIDGE_DISPATCH_SECRET_PARAM = process.env.BRIDGE_DISPATCH_SECRET_PARAM || '';

async function getBridgeDispatchSecret() {
  if (!BRIDGE_DISPATCH_SECRET_PARAM) return '';
  return getSecureParam(BRIDGE_DISPATCH_SECRET_PARAM);
}

// LWA (Login With Amazon) credentials — used in AcceptGrant to trade an
// authorization code for the user's refresh_token, and (in Phase 4 events)
// to mint short-lived access tokens for the Alexa Event Gateway.
// Both come from SSM SecureString — same caching as the bridge secret.
const LWA_CLIENT_ID_PARAM     = process.env.LWA_CLIENT_ID_PARAM || '';
const LWA_CLIENT_SECRET_PARAM = process.env.LWA_CLIENT_SECRET_PARAM || '';
const LWA_TOKEN_URL           = 'https://api.amazon.com/auth/o2/token';

async function getLwaCredentials() {
  if (!LWA_CLIENT_ID_PARAM || !LWA_CLIENT_SECRET_PARAM) {
    throw new Error('LWA SSM params are not configured (LWA_CLIENT_ID_PARAM / LWA_CLIENT_SECRET_PARAM)');
  }
  const [clientId, clientSecret] = await Promise.all([
    getSecureParam(LWA_CLIENT_ID_PARAM),
    getSecureParam(LWA_CLIENT_SECRET_PARAM),
  ]);
  return { clientId, clientSecret };
}

// Exchange a one-shot LWA authorization code (received in AcceptGrant) for
// an { access_token, refresh_token, expires_in } triple. We persist the
// refresh_token; the access_token is re-minted on demand for each
// ChangeReport (~1 hour TTL, cheap to refresh, no per-row bookkeeping).
async function exchangeLwaCode(code) {
  const { clientId, clientSecret } = await getLwaCredentials();
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LWA token exchange failed: HTTP ${res.status} ${text}`);
  }
  return res.json();
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Alexa Smart Home requires a response within 8 seconds. Reserve some headroom
// for response serialization and potential cold-start tail.
const FORWARD_TIMEOUT_MS = 6000;

// Directive namespaces this handler currently supports (Phase 1 = first two).
// Phase 2 turns on PowerController + BrightnessController on the Loxberry side.
// Phases 3 & 4 add the rest. Forwarding logic is namespace-agnostic, so any
// directive in this allow-list is forwarded as-is to the Loxberry plugin.
const SUPPORTED_NAMESPACES = new Set([
  'Alexa',                              // ReportState lives here (name=ReportState)
  'Alexa.Discovery',                    // Discover
  'Alexa.PowerController',              // TurnOn / TurnOff
  'Alexa.ModeController',               // SetMode / AdjustMode (LightControllerV2 moods)
  'Alexa.BrightnessController',         // SetBrightness / AdjustBrightness
  'Alexa.ColorController',              // SetColor (ColorPickerV2 HSV)
  'Alexa.ColorTemperatureController',   // SetColorTemperatureInKelvin / Increase / Decrease
  'Alexa.ThermostatController',         // (Phase 3)
  'Alexa.RangeController',              // blinds (Phase 3)
  'Alexa.SceneController',              // (Phase 3)
  'Alexa.PlaybackController',           // (Phase 3)
  'Alexa.Speaker',                      // (Phase 3)
]);

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

exports.handler = async (event, context) => {
  const requestId = context.awsRequestId;
  const directive = event && event.directive;
  const header = directive && directive.header;
  const namespace = header && header.namespace;
  const name = header && header.name;
  const correlationToken = header && header.correlationToken;
  const messageId = header && header.messageId;

  // DEBUG-level: at scale (100+ devices × ReportState every minute) this fires
  // hundreds of times per minute per user. Operators don't normally need to
  // see every individual directive; errors below are at WARN/ERROR and surface
  // the abnormal cases. Flip LOG_LEVEL=DEBUG to investigate.
  log.debug('alexa.directive.received', { requestId, namespace, name, messageId });

  if (!directive || !header) {
    return errorResponse({
      type: 'INVALID_DIRECTIVE',
      message: 'Missing directive or header',
      correlationToken,
    });
  }

  try {
    // AcceptGrant has its own auth flow (token in payload.grantee).
    if (namespace === 'Alexa.Authorization' && name === 'AcceptGrant') {
      return await handleAcceptGrant(directive);
    }

    // Every other directive carries a Bearer token. Find it and verify.
    const token = extractBearerToken(directive);
    if (!token) {
      return errorResponse({
        type: 'INVALID_AUTHORIZATION_CREDENTIAL',
        message: 'No bearer token in directive',
        correlationToken,
      });
    }

    let userId;
    try {
      ({ userId } = await verifyAccessToken(token));
    } catch (err) {
      log.warn('alexa.jwt.invalid', { requestId, error: err.message });
      return errorResponse({
        type: 'INVALID_AUTHORIZATION_CREDENTIAL',
        message: 'Token verification failed',
        correlationToken,
      });
    }

    // Discovery has no endpoint context; everything else does.
    const endpointId = directive.endpoint && directive.endpoint.endpointId;

    const user = await loadUser(userId);
    if (!user) {
      log.warn('alexa.user.unknown', { requestId, userId });
      return errorResponse({
        type: 'INVALID_AUTHORIZATION_CREDENTIAL',
        message: 'User not found',
        correlationToken,
        endpointId,
      });
    }

    if (!SUPPORTED_NAMESPACES.has(namespace)) {
      return errorResponse({
        type: 'INVALID_DIRECTIVE',
        message: `Unsupported namespace: ${namespace}`,
        correlationToken,
        endpointId,
      });
    }

    return await forwardDirective({ user, directive, requestId });
  } catch (err) {
    log.error('alexa.unhandled', { requestId, error: err.message, stack: err.stack });
    return errorResponse({
      type: 'INTERNAL_ERROR',
      message: 'Internal error',
      correlationToken,
    });
  }
};

// -----------------------------------------------------------------------------
// Forwarding to bridge → daemon
// -----------------------------------------------------------------------------
//
// We POST to ${BRIDGE_URL}/dispatch with:
//   - X-Bridge-Auth: BRIDGE_DISPATCH_SECRET            (bridge ↔ Lambda)
//   - body: { userId, directive, headers }             (the bridge routes by userId)
//   - headers.x-aloxberry-{timestamp,signature}          (signed with skillSecret;
//                                                       bridge passes through,
//                                                       daemon verifies E2E)
//
// The bridge wraps the directive into a WSS frame and forwards to the user's
// plugin daemon. The bridge cannot forge a valid signature: only the Lambda
// and the daemon know `skillSecret`.

async function forwardDirective({ user, directive, requestId }) {
  const correlationToken = directive.header && directive.header.correlationToken;
  const endpointId = directive.endpoint && directive.endpoint.endpointId;
  const ns = directive.header && directive.header.namespace;
  const opName = directive.header && directive.header.name;
  const dispatchStart = Date.now();

  let bridgeSecret;
  try {
    bridgeSecret = await getBridgeDispatchSecret();
  } catch (err) {
    log.error('alexa.bridge.ssm_failed', { requestId, error: err.message });
    bridgeSecret = '';
  }
  if (!BRIDGE_URL || !bridgeSecret) {
    log.error('alexa.bridge.unconfigured', {
      requestId,
      hasBridgeUrl: !!BRIDGE_URL,
      hasBridgeSecret: !!bridgeSecret,
    });
    if (directive.header.namespace === 'Alexa.Discovery') return discoverResponse([]);
    return errorResponse({
      type: 'INTERNAL_ERROR',
      message: 'Bridge configuration missing',
      correlationToken,
      endpointId,
    });
  }
  if (!user.bridgeUserId || !user.skillSecret) {
    log.error('alexa.user.unmigrated', {
      requestId,
      userId: user.userId,
      hasBridgeUserId: !!user.bridgeUserId,
      hasSkillSecret: !!user.skillSecret,
    });
    if (directive.header.namespace === 'Alexa.Discovery') return discoverResponse([]);
    return errorResponse({
      type: 'INVALID_AUTHORIZATION_CREDENTIAL',
      message: 'Linked account is missing bridge credentials — please re-link',
      correlationToken,
      endpointId,
    });
  }

  // The directive forwarded through the bridge keeps its envelope but loses
  // the Bearer token (the daemon doesn't need it; reduces blast radius if
  // logs leak the body anywhere along the path).
  const safeDirective = redactToken(directive);
  const directiveBody = JSON.stringify(safeDirective);

  // End-to-end HMAC: signed over the directive JSON only (not the wrapper).
  // The daemon re-stringifies what it receives in `msg.directive` and verifies.
  // skillSecret is stored as hex in DDB; the daemon holds the same 32 raw
  // bytes, so we have to decode here for the HMAC keys to match.
  let secretBuf;
  try {
    secretBuf = Buffer.from(user.skillSecret, 'hex');
  } catch (err) {
    log.error('alexa.user.bad_skill_secret', { userId: user.userId, error: err.message });
    return errorResponse({
      type: 'INTERNAL_ERROR',
      message: 'stored credential is malformed',
      correlationToken, endpointId,
    });
  }
  const signed = signAloxberryRequest({ secret: secretBuf, body: directiveBody });

  const dispatchBody = JSON.stringify({
    userId: user.bridgeUserId,
    directive: safeDirective,
    headers: {
      [HEADER_ALOXBERRY_TIMESTAMP]: signed[HEADER_ALOXBERRY_TIMESTAMP],
      [HEADER_ALOXBERRY_SIGNATURE]: signed[HEADER_ALOXBERRY_SIGNATURE],
      // Display-only metadata: lets the daemon's CGI show which Alexa
      // account this directive came from. NOT covered by the HMAC, so
      // a compromised bridge could spoof these values — that's fine for
      // display but the daemon must not make trust decisions on them.
      'x-aloxberry-pairing-id': user.userId,
      'x-aloxberry-pairing-name': user.friendlyName || '',
    },
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FORWARD_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${BRIDGE_URL}/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bridge-auth': bridgeSecret,
        'user-agent': 'aloxberry-alexa-handler/0.1',
      },
      body: dispatchBody,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    log.warn('alexa.dispatch.failed', { requestId, error: err.message });
    if (directive.header.namespace === 'Alexa.Discovery') return discoverResponse([]);
    return errorResponse({
      type: 'ENDPOINT_UNREACHABLE',
      message: 'Bridge not reachable',
      correlationToken,
      endpointId,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  // The bridge returns 200 with the plugin's response on success.
  // 504 = plugin offline / timeout (we map both to ENDPOINT_UNREACHABLE so
  //       Alexa knows to "device is unresponsive" rather than fail the skill).
  // 401 = our BRIDGE_DISPATCH_SECRET is wrong (operator misconfiguration).
  // 503 = bridge isn't configured. Treat like 401 for the user-visible side.
  if (res.status === 504) {
    log.info('alexa.dispatch.offline', { requestId, body: text.slice(0, 200) });
    if (directive.header.namespace === 'Alexa.Discovery') return discoverResponse([]);
    return errorResponse({
      type: 'ENDPOINT_UNREACHABLE',
      message: 'Loxberry plugin offline or unresponsive',
      correlationToken,
      endpointId,
    });
  }
  if (res.status !== 200) {
    log.warn('alexa.dispatch.bad_status', { requestId, status: res.status, body: text.slice(0, 200) });
    if (directive.header.namespace === 'Alexa.Discovery') return discoverResponse([]);
    return errorResponse({
      type: 'BRIDGE_UNREACHABLE',
      message: `Bridge returned HTTP ${res.status}`,
      correlationToken,
      endpointId,
    });
  }

  // We trust the plugin to return a fully-formed Alexa response envelope.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.error('alexa.dispatch.bad_json', { requestId });
    if (directive.header.namespace === 'Alexa.Discovery') return discoverResponse([]);
    return errorResponse({
      type: 'INTERNAL_ERROR',
      message: 'Bridge returned malformed JSON',
      correlationToken,
      endpointId,
    });
  }

  // Shape-check Discovery responses specifically. A 200 with the wrong JSON
  // shape (e.g. a stub server like httpbin echoing the request body back, or
  // a misconfigured plugin) would otherwise propagate into Alexa's runtime
  // and trip the entire skill — including the immediate post-link Discovery
  // pass, which Alexa interprets as "linking failed".
  if (directive.header.namespace === 'Alexa.Discovery') {
    const endpoints = parsed && parsed.event && parsed.event.payload && parsed.event.payload.endpoints;
    if (!Array.isArray(endpoints)) {
      log.warn('alexa.dispatch.malformed_discovery', { requestId });
      return discoverResponse([]);
    }
  }

  // Success-path visibility. Two-tier logging so we don't burn CloudWatch
  // at production scale:
  //   DEBUG — every successful dispatch (high volume — every ReportState
  //           poll, every voice command). Includes full ReportState
  //           property dump for "what exactly did we send Alexa?" forensics.
  //   INFO  — slow dispatches only (the same data, gated on elapsedMs > 2s).
  //           Catches degraded performance without per-request noise.
  const elapsedMs = Date.now() - dispatchStart;
  const respHeader = parsed?.event?.header;
  const slow = elapsedMs > 2000;
  if (ns === 'Alexa' && opName === 'ReportState') {
    // ReportState response shape: { event: { header: {name:"StateReport",...} },
    //                               context: { properties: [...] } }
    const props = parsed?.context?.properties || [];
    const propSummary = props.map((p) => {
      const id = p.instance ? `${p.namespace}(${p.instance}).${p.name}` : `${p.namespace}.${p.name}`;
      let v;
      if (p.value && typeof p.value === 'object') v = JSON.stringify(p.value);
      else v = String(p.value);
      return `${id}=${v}`;
    });
    const fields = {
      requestId, endpointId,
      respName: respHeader?.name,
      propertyCount: props.length,
      properties: propSummary,
      elapsedMs,
    };
    if (slow) log.warn('alexa.dispatch.statereport_slow', fields);
    else      log.debug('alexa.dispatch.statereport', fields);
  } else {
    const fields = {
      requestId, endpointId,
      namespace: ns, name: opName,
      respName: respHeader?.name,
      elapsedMs,
    };
    if (slow) log.warn('alexa.dispatch.success_slow', fields);
    else      log.debug('alexa.dispatch.success', fields);
  }

  return parsed;
}

// -----------------------------------------------------------------------------
// AcceptGrant — Alexa hands us a code we trade at LWA for a refresh_token.
// The refresh_token is persisted onto the user row. Phase 4 outbound events
// (oauth-handler /event) read it and mint short-lived access tokens to
// authorize POSTs to the Alexa Event Gateway.
// -----------------------------------------------------------------------------

async function handleAcceptGrant(directive) {
  const granteeToken = directive.payload && directive.payload.grantee && directive.payload.grantee.token;
  const grantCode    = directive.payload && directive.payload.grant    && directive.payload.grant.code;

  if (!granteeToken) {
    return acceptGrantErrorResponse('ACCEPT_GRANT_FAILED', 'AcceptGrant missing grantee token');
  }
  if (!grantCode) {
    return acceptGrantErrorResponse('ACCEPT_GRANT_FAILED', 'AcceptGrant missing grant.code');
  }

  let userId;
  try {
    ({ userId } = await verifyAccessToken(granteeToken));
  } catch (err) {
    log.warn('alexa.acceptgrant.jwt_invalid', { error: err.message });
    return acceptGrantErrorResponse('ACCEPT_GRANT_FAILED', 'Invalid grantee token');
  }

  // Trade the one-shot code for tokens. Failure modes here are all
  // ACCEPT_GRANT_FAILED from Alexa's perspective; we log the underlying
  // reason for ourselves.
  let tokens;
  try {
    tokens = await exchangeLwaCode(grantCode);
  } catch (err) {
    log.error('alexa.acceptgrant.lwa_exchange_failed', { userId, error: err.message });
    return acceptGrantErrorResponse('ACCEPT_GRANT_FAILED', 'LWA token exchange failed');
  }
  if (!tokens.refresh_token) {
    log.error('alexa.acceptgrant.no_refresh_token', { userId, keys: Object.keys(tokens || {}) });
    return acceptGrantErrorResponse('ACCEPT_GRANT_FAILED', 'LWA response missing refresh_token');
  }

  // Persist. ConditionExpression guards against an AcceptGrant arriving
  // before the OAuth /token call has created the user row — without it
  // we'd write a phantom row with only LWA tokens and no skillSecret /
  // bridgeUserId, which would later look like a corrupted account.
  try {
    await getDocClient().send(new UpdateCommand({
      TableName: tableNames.users,
      Key: { userId },
      UpdateExpression:
        'SET lwaRefreshToken = :rt, lwaGrantedAt = :now, updatedAt = :now',
      ExpressionAttributeValues: {
        ':rt':  tokens.refresh_token,
        ':now': new Date().toISOString(),
      },
      ConditionExpression: 'attribute_exists(userId)',
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      log.warn('alexa.acceptgrant.user_not_found', { userId });
      return acceptGrantErrorResponse('ACCEPT_GRANT_FAILED', 'User not found');
    }
    log.error('alexa.acceptgrant.ddb_failed', { userId, error: err.message });
    return acceptGrantErrorResponse('ACCEPT_GRANT_FAILED', 'Could not persist tokens');
  }

  log.info('alexa.acceptgrant.tokens_persisted', { userId });

  return {
    event: {
      header: {
        namespace: 'Alexa.Authorization',
        name: 'AcceptGrant.Response',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      payload: {},
    },
  };
}

function acceptGrantErrorResponse(type, message) {
  return {
    event: {
      header: {
        namespace: 'Alexa.Authorization',
        name: 'ErrorResponse',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      payload: { type, message },
    },
  };
}

// -----------------------------------------------------------------------------
// DynamoDB
// -----------------------------------------------------------------------------

async function loadUser(userId) {
  const res = await getDocClient().send(new GetCommand({
    TableName: tableNames.users,
    Key: { userId },
  }));
  return res.Item || null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractBearerToken(directive) {
  // Discovery: directive.payload.scope.token
  // AcceptGrant: directive.payload.grantee.token (handled separately)
  // Everything else: directive.endpoint.scope.token
  return (
    (directive.endpoint && directive.endpoint.scope && directive.endpoint.scope.token) ||
    (directive.payload && directive.payload.scope && directive.payload.scope.token) ||
    null
  );
}

function redactToken(directive) {
  // Shallow clone the relevant pieces and drop the token before forwarding.
  const cloned = JSON.parse(JSON.stringify(directive));
  if (cloned.endpoint && cloned.endpoint.scope) cloned.endpoint.scope = { type: 'BearerToken' };
  if (cloned.payload && cloned.payload.scope) cloned.payload.scope = { type: 'BearerToken' };
  return cloned;
}

// -----------------------------------------------------------------------------
// Response builders
// -----------------------------------------------------------------------------

function discoverResponse(endpoints) {
  return {
    event: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'Discover.Response',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      payload: { endpoints },
    },
  };
}

function errorResponse({ type, message, correlationToken, endpointId }) {
  const event = {
    header: {
      namespace: 'Alexa',
      name: 'ErrorResponse',
      messageId: randomUUID(),
      payloadVersion: '3',
    },
    payload: { type, message },
  };
  if (correlationToken) event.header.correlationToken = correlationToken;
  if (endpointId) event.endpoint = { endpointId };
  return { event };
}
