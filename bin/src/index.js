'use strict';

// Aloxberry plugin daemon — entry point.
//
// Boot sequence:
//   1. Parse config (fail loud if anything is missing).
//   2. Load/generate persistent identity (userId + skillSecret).
//   3. Load/generate the daemon UUID (Loxone client identity — unrelated to
//      the bridge userId; this one is the Miniserver's client identifier).
//   4. Bring up the Miniserver session — auth + subscribe to events, keep
//      it healthy via reconnect + token refresh. Non-blocking on failure;
//      the session retries forever in the background.
//   5. Bring up the bridge WSS client with a directive router wired in.
//      Inbound Alexa directives → router → Loxone commands → response.
//   6. Bring up the loopback HTTP API (port 7800) for the CGI to call.
//   7. Periodically reflect connection/event state into data/state.json
//      so the Perl CGI status page can read what's going on.

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { createLogger } = require('./log');

const { loadConfig } = require('./config');
const identityModule = require('./identity');
const { StateWriter, STATE_VERSION } = require('./state');
const { BridgeClient } = require('./bridge-client');
const { LocalHttpServer } = require('./local-http');
const { PairingsTracker } = require('./pairings');
const { StructureCache } = require('./structure');
const { DevicesConfig } = require('./devices-config');
const { load: loadMsConfig, loadWithCredentials } = require('./miniserver-config');
const { fetchPublicKey } = require('./miniserver-probe');
const { MiniserverTokenStore } = require('./miniserver-token-store');
const { MiniserverStateCache } = require('./state-cache');
const { StateReporter } = require('./state-reporter');
const { MiniserverSession } = require('./miniserver-session');
const { LoxoneCommandClient } = require('./loxone-command');
const { DirectiveRouter, defaultEndpointsForTesting } = require('./directive-router');
const { loadOrCreate: loadOrCreateDaemonUuid } = require('./daemon-uuid');

const STATE_FLUSH_INTERVAL_MS = 30_000;

// ----- Config -------------------------------------------------------------

const config = loadConfig();
const log = createLogger({ level: config.logLevel });

// ----- Persistent identity (userId + skillSecret) -------------------------
// On first boot, this generates fresh random values and persists to disk.
// On subsequent boots, it reads them back. Rotated only by an explicit
// "kill all pairings" request via the local HTTP API.
const identityDir = config.identityDir || path.join(config.dataDir, 'identity');
const identityRef = {
  identityDir,
  current: identityModule.loadOrCreate({ identityDir, log }),
};

// ----- Shared state writer (drives data/state.json) ------------------------

const state = new StateWriter({ dataDir: config.dataDir, log });

// ----- Pairings tracker (drives data/pairings.json) -----------------------
// Records each Alexa account the daemon has seen a directive from, with
// firstSeen / lastSeen / directiveCount. Read by the CGI for the "Active
// pairings" panel. Wiped on identity rotation (kill-pairings).
const pairings = new PairingsTracker({ dataDir: config.dataDir, log });

// References held at module scope so the shutdown handler can stop them.
let bridgeClient = null;
let localHttp = null;
let session = null;
let stateFlushTimer = null;
let devicesConfigRef = null;

// ----- Main ---------------------------------------------------------------

async function main() {
  log.info(
    {
      pid: process.pid,
      node: process.version,
      stateVersion: STATE_VERSION,
      dataDir: config.dataDir,
      bridgeUrl: config.bridgeUrl,
      userId: identityRef.current.userId,
      identityWasCreated: identityRef.current.wasCreated,
    },
    'aloxberry-daemon starting',
  );

  state.ensureDirSync();
  await state.update({ status: 'running' });

  // --- Miniserver session (best-effort start; reconnects forever on failure)
  const stateCache = new MiniserverStateCache();
  const daemonUuid = loadOrCreateDaemonUuid(config.dataDir);
  log.info({ daemonUuid }, 'daemon UUID loaded');

  try {
    const [msConfig] = await loadMsConfig();
    const pem = await fetchPublicKey(msConfig);
    const publicKey = crypto.createPublicKey(pem);
    const tokenStore = new MiniserverTokenStore({ dataDir: config.dataDir, log });

    session = new MiniserverSession({
      msConfig, publicKey, daemonUuid, tokenStore, stateCache, log,
      getCredentials: async () => {
        // Re-read fresh from LoxBerry's config each time we need creds (rare —
        // only on first auth or after a token kill). Pass_RAW handling lives
        // in lox-getconfig.pl.
        const [withCreds] = await loadWithCredentials();
        return withCreds.getCredentialsForAuth();
      },
    });
    session.on('authenticated', ({ viaCachedToken }) => {
      log.info({ viaCachedToken }, 'miniserver authenticated');
    });
    session.on('subscribed', async () => {
      await state.update({ miniserver: { connected: true, lastError: null } });
    });
    session.on('disconnected', async (info) => {
      await state.update({
        miniserver: {
          connected: false,
          lastError: info?.reason || (info?.code ? `code ${info.code}` : 'disconnected'),
        },
      });
    });
    session.on('token-refreshed', (info) => {
      log.info(info, 'miniserver token refreshed');
    });

    // Fire-and-forget — _connectOnce handles its own errors and reschedules.
    session.start().catch((err) => {
      log.warn({ err: err.message }, 'miniserver session start threw — reconnect loop is on');
    });
  } catch (err) {
    log.warn({ err: err.message }, 'miniserver bootstrap failed — daemon stays up; bridge still active');
    await state.update({ miniserver: { connected: false, lastError: `bootstrap: ${err.message}` } });
  }

  // --- Structure cache (LoxAPP3.json) -------------------------------------
  // Load from disk synchronously-ish so /catalogue has SOMETHING to return
  // before the first live refresh completes. Then kick off an async refresh
  // in the background (don't await — first boot would otherwise block on
  // the Miniserver being reachable).
  const structureCache = new StructureCache({ dataDir: config.dataDir, log });
  await structureCache.loadFromDisk();
  structureCache.refresh({ msNo: 1 }).catch((err) => {
    log.warn({ err: err.message }, 'initial structure refresh failed — will retry next boot');
  });

  // --- Devices config (devices.json, hot-reloaded) ------------------------
  const devicesConfig = new DevicesConfig({ configDir: config.configDir, log });
  devicesConfigRef = devicesConfig;
  await devicesConfig.start();

  // --- Directive router (Alexa command translator) -------------------------
  // The router doesn't depend on the Miniserver session being up; the
  // directive handler returns ENDPOINT_UNREACHABLE via LoxoneCommandClient
  // when the underlying Perl helper fails. So we always wire it.
  //
  // Endpoint list is now driven by devices.json. When that file changes
  // (chokidar watcher in DevicesConfig), we swap the router's endpoint set.
  // Falls back to the hardcoded test endpoint when devices.json is empty
  // so first-install users still see one device for Alexa to discover.
  const loxoneCommand = new LoxoneCommandClient({ log });
  const initialEndpoints = devicesConfig.list().length > 0
    ? devicesConfig.toEndpoints()
    : defaultEndpointsForTesting();

  // getOperatingMode: queries the live state cache for the current value of
  // the operating-mode state UUID (extracted from LoxAPP3.json). Returns
  // null when the cache hasn't received the value yet (cold start) — the
  // router treats null as "don't block", which is the safer default during
  // startup.
  const getOperatingMode = () => {
    const cat = structureCache.getCatalogue();
    if (!cat || !cat.operatingModeStateUuid) {
      log.debug({ hasCatalogue: !!cat, operatingModeStateUuid: cat && cat.operatingModeStateUuid },
        'getOperatingMode: no operating-mode state UUID (vacation gate cannot work)');
      return null;
    }
    const entry = stateCache.getValue(cat.operatingModeStateUuid);
    log.debug(
      { operatingModeStateUuid: cat.operatingModeStateUuid,
        hasCacheEntry: !!entry, value: entry ? entry.value : null },
      'getOperatingMode: resolved',
    );
    return entry ? entry.value : null;
  };

  const directiveRouter = new DirectiveRouter({
    loxoneCommand,
    endpoints: initialEndpoints,
    log,
    getGlobals: () => devicesConfig.getGlobals(),
    getOperatingMode,
    // Optional caches — when present, Discovery advertises ModeController for
    // LightControllerV2 endpoints whose moodList state has been observed,
    // and ReportState answers with live activeMoods-derived values. Absent
    // both, Discovery / ReportState behave as before (PowerController only,
    // stubbed state).
    structureCache,
    stateCache,
  });
  devicesConfig.on('change', () => {
    // Boundary instrumentation: a silent hang was observed immediately
    // after a devices.json reload. These DEBUG lines bracket every step so
    // the LAST surviving log localizes the blocking/throwing call. The
    // try/catch ensures a throw here is logged (and the daemon survives)
    // instead of unwinding out of the EventEmitter and killing the process.
    log.debug('devices change handler: enter');
    try {
      const next = devicesConfig.list().length > 0
        ? devicesConfig.toEndpoints()
        : defaultEndpointsForTesting();
      log.debug({ endpointCount: next.length }, 'devices change handler: toEndpoints done');
      directiveRouter.setEndpoints(next);
      log.debug('devices change handler: setEndpoints done');
      // Also apply the master switch on every devices.json change. The router
      // re-reads globals on each directive (via getGlobals callback), so no
      // explicit call is needed for the vacation gate; only the bridge-client
      // master switch needs an action — connect or suspend.
      bridgeClient.setEnabled(devicesConfig.getGlobals().enabled);
      log.debug('devices change handler: setEnabled done (handler complete)');
    } catch (err) {
      log.error({ err: err && err.stack || String(err) },
        'devices change handler threw — daemon kept alive, reload may be partially applied');
    }
  });

  // --- Bridge client ------------------------------------------------------
  bridgeClient = new BridgeClient({
    config, identity: identityRef.current, state, log, pairings,
    directiveHandler: (directive) => directiveRouter.handle(directive),
  });
  // When the local-http "reset-pairings" handler swaps identityRef.current,
  // it also calls bridgeClient.forceReconnect(). But on the next hello we
  // still need to send the NEW userId, so wire bridgeClient to re-read from
  // identityRef each connect. Done by replacing its identity reference here.
  Object.defineProperty(bridgeClient, 'identity', {
    get: () => identityRef.current,
  });
  // Apply the master-switch state from devices.json BEFORE starting. If
  // the user had previously toggled it off, start() will become a no-op
  // and the daemon will stay disconnected from the bridge until the CGI
  // flips it back on.
  bridgeClient.setEnabled(devicesConfig.getGlobals().enabled);
  bridgeClient.start();

  // --- State reporter (Phase 4 outbound) ----------------------------------
  // Watches state-cache for transitions on exposed-device state-UUIDs and
  // pushes Alexa ChangeReports through the bridge. The reporter doesn't
  // own transport (bridgeClient.sendReport handles that) or token state
  // (the Lambda manages LWA tokens per-user). It just translates Loxone
  // state diffs into Alexa-shaped events and signs them with the daemon's
  // skillSecret.
  const stateReporter = new StateReporter({
    structure:     structureCache,
    devicesConfig,
    stateCache,
    bridgeClient,
    identity:      identityRef.current,
    log,
  });
  stateReporter.start();

  // --- Local HTTP API (CGI ↔ daemon) --------------------------------------
  localHttp = new LocalHttpServer({
    port: config.localHttpPort || 7800,
    state,
    bridgeClient,
    identityRef,
    pairings,
    structureCache,
    stateReporter,
    log,
  });
  try {
    await localHttp.start();
  } catch (err) {
    log.error({ err: err.message }, 'local http failed to start — CGI control surface unavailable');
  }

  // --- Periodic flush of miniserver event-count summary to state.json ----
  stateFlushTimer = setInterval(async () => {
    const summary = stateCache.snapshotSummary();
    await state.update({
      miniserver: {
        eventsSeen: summary.eventsSeen,
        valueCount: summary.valueCount,
        textCount: summary.textCount,
        lastEventAt: summary.lastEventAt,
      },
    });
  }, STATE_FLUSH_INTERVAL_MS);
  stateFlushTimer.unref();
}

main().catch((err) => fatalExit('fatal during startup', err));

// ----- Shutdown -----------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutdown requested');

  if (stateFlushTimer) clearInterval(stateFlushTimer);

  // Stop in reverse boot order — local-http first (no more inbound), then
  // bridge (no more directives), then miniserver session.
  if (localHttp) {
    try { await localHttp.stop(); }
    catch (err) { log.warn({ err: err.message }, 'local http stop raised'); }
  }
  if (bridgeClient) {
    try { await bridgeClient.stop(); }
    catch (err) { log.warn({ err: err.message }, 'bridge stop raised'); }
  }
  if (session) {
    try { await session.stop(); }
    catch (err) { log.warn({ err: err.message }, 'miniserver session stop raised'); }
  }
  if (devicesConfigRef) {
    try { await devicesConfigRef.stop(); }
    catch (err) { log.warn({ err: err.message }, 'devices-config stop raised'); }
  }

  try { await state.update({ status: 'stopping' }); } catch { /* logged in StateWriter */ }
  log.info('goodbye');
  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Normalize anything thrown/rejected (Error, string, object, undefined)
// into a stable { name, message, stack } shape. unhandledRejection's
// `reason` is frequently NOT an Error — `{ reason }` alone silently drops
// the stack and is useless for a non-Error reject.
function normalizeError(e) {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  if (e && typeof e === 'object') {
    try { return { name: 'NonError', message: JSON.stringify(e), stack: e.stack || null }; }
    catch { return { name: 'NonError', message: String(e), stack: null }; }
  }
  return { name: 'NonError', message: String(e), stack: null };
}

// Crash path. The bug we were chasing: the previous handlers did
// `log.fatal(...)` then a SYNCHRONOUS `process.exit(1)`. The logger writes
// via process.stdout.write, which is ASYNC when stdout is a pipe/file (it
// always is under the LoxBerry log redirect) — so exit() truncated the
// unflushed buffer and the fatal line was lost, leaving "daemon gone, no
// error logged". Fix: (1) a synchronous fs.writeSync to fd 2 that cannot be
// buffered away, so a forensic line ALWAYS survives; (2) the structured
// log.fatal for normal observability; (3) a short unref'd delay before
// exit so the async stdout buffer drains too — same idiom as shutdown().
function fatalExit(label, errLike) {
  const e = normalizeError(errLike);
  // (1) Guaranteed-durable line — bypasses the async logger entirely.
  try {
    fs.writeSync(2,
      `${new Date().toISOString()} [FATAL] ${label}: ${e.name}: ${e.message}\n` +
      `${e.stack || '(no stack)'}\n`);
  } catch { /* fd 2 unwritable — nothing more we can do */ }
  // (2) Structured record for log scrapers (best-effort; may be buffered).
  try { log.fatal({ err: e }, label); } catch { /* logger itself broke */ }
  // (3) Give the async stdout buffer a tick to drain, then exit. unref'd so
  // it can't itself keep a dead process alive.
  setTimeout(() => process.exit(1), 100).unref();
}

process.on('uncaughtException', (err) => fatalExit('uncaughtException', err));
process.on('unhandledRejection', (reason) => fatalExit('unhandledRejection', reason));
