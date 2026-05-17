'use strict';

// Loopback HTTP API on 127.0.0.1:7800 — the daemon's local control surface.
// Called by the LoxBerry plugin CGI (which runs on the same box). External
// access is *not* permitted: the server binds explicitly to 127.0.0.1, and
// the LoxBerry's own htmlauth gate guards anyone reaching the CGI in the
// first place.
//
// Endpoints (all JSON):
//
//   GET  /status            → liveness + current state.json snapshot
//   POST /pair              → generate 10-char code, publish to bridge over WSS,
//                             return { code, expiresInSec }
//   POST /reset-pairings    → rotate userId + skillSecret, reconnect bridge.
//                             Existing Alexa links become orphans (504-offline).
//                             Returns the new identity for the CGI to display.
//
// No request body required for either POST. POSTs are POSTs (not GETs) only
// to make accidental browser-bar invocation impossible.

const http = require('node:http');

const pairCode = require('./pair-code');
const identity = require('./identity');
const { IMPLEMENTED_CAPABILITIES } = require('./directive-router');

const PAIR_TTL_MS = 10 * 60 * 1000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > 64 * 1024) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Loopback only; still tell caches not to keep this.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

class LocalHttpServer {
  constructor({
    port = 7800, host = '127.0.0.1',
    state, bridgeClient, identityRef, pairings, structureCache, stateReporter,
    log,
  }) {
    this.port = port;
    this.host = host;
    this.state = state;
    this.bridgeClient = bridgeClient;
    // `identityRef` is a mutable holder { identityDir, current } so the
    // reset-pairings handler can both swap `current` in place AND tell the
    // bridge client to use the new value on reconnect.
    this.identityRef = identityRef;
    this.pairings = pairings || null;
    this.structureCache = structureCache || null;
    this.stateReporter = stateReporter || null;
    this.log = log.child({ component: 'local-http' });
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.log.info({ host: this.host, port: this.port }, 'local http listening');
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.log.info('local http closed');
        resolve();
      });
    });
  }

  // ----- routing ---------------------------------------------------------

  async handle(req, res) {
    const { method, url } = req;
    const path = url.split('?', 1)[0];

    try {
      if (path === '/status' && method === 'GET') return await this.getStatus(res);
      if (path === '/pairings' && method === 'GET') return await this.getPairings(res);
      if (path === '/catalogue' && method === 'GET') return await this.getCatalogue(req, res);
      if (path === '/pair' && method === 'POST') return await this.postPair(req, res);
      if (path === '/reset-pairings' && method === 'POST') return await this.postResetPairings(req, res);
      if (path === '/resync-state' && method === 'POST') return await this.postResyncState(res);

      if (method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      return writeJson(res, 404, { error: 'not_found' });
    } catch (err) {
      this.log.error({ err: err.message, path, method }, 'local http handler threw');
      if (!res.headersSent) writeJson(res, 500, { error: 'internal', message: err.message });
    }
  }

  // ----- handlers --------------------------------------------------------

  async getPairings(res) {
    if (!this.pairings) return writeJson(res, 200, { pairings: [] });
    return writeJson(res, 200, { pairings: this.pairings.list() });
  }

  // GET /catalogue                     → cached LoxAPP3 catalogue (fast)
  // GET /catalogue?refresh=1           → force a fetch from the Miniserver first
  //                                       (used by the picker's "Refresh from
  //                                        Miniserver" button)
  // GET /catalogue?refresh=1&msNo=2    → refresh against a specific Miniserver
  async getCatalogue(req, res) {
    if (!this.structureCache) {
      return writeJson(res, 503, { error: 'structure_cache_unavailable' });
    }
    const u = new URL(req.url, 'http://localhost');
    const wantRefresh = u.searchParams.get('refresh') === '1';
    const msNo = Number.parseInt(u.searchParams.get('msNo') || '1', 10);

    if (wantRefresh) {
      try {
        await this.structureCache.refresh({ msNo });
      } catch (err) {
        this.log.warn({ err: err.message }, '/catalogue refresh failed');
        // Fall through — getCatalogue() may still have cached data to return.
      }
    }
    const cat = this.structureCache.getCatalogue();
    if (!cat) {
      return writeJson(res, 503, {
        error: 'no_catalogue_yet',
        hint: 'Miniserver was never successfully reached; try with ?refresh=1 once the Miniserver is online.',
      });
    }
    // Augment the catalogue with the daemon's authoritative list of which
    // Alexa capabilities have a real handler in the dispatch right now.
    // The picker UI uses this to decide which capability checkboxes are
    // toggleable on a device — previously this list was duplicated as a
    // hardcoded V1_CAPS map in devices.html and drifted out of sync. A
    // shallow spread keeps `cat` (the StructureCache's snapshot) immutable.
    return writeJson(res, 200, {
      ...cat,
      implementedCapabilities: IMPLEMENTED_CAPABILITIES,
    });
  }

  async getStatus(res) {
    // state.json is already the canonical truth. We just add a couple of
    // process-level things the file doesn't track (alive, uptime, identity
    // userId for display) so the CGI doesn't need to also stat the proc.
    // StateWriter.snapshot() returns an in-memory deep clone — sync and cheap.
    const snapshot = this.state.snapshot ? this.state.snapshot() : {};
    return writeJson(res, 200, {
      alive: true,
      pid: process.pid,
      startedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      userId: this.identityRef.current.userId,
      state: snapshot,
    });
  }

  async postPair(_req, res) {
    if (!this.bridgeClient) {
      return writeJson(res, 503, { error: 'bridge_client_unavailable' });
    }
    const code = pairCode.generate();
    try {
      await this.bridgeClient.publishPairCode(code);
    } catch (err) {
      this.log.warn({ err: err.message }, 'pair-publish failed');
      // Map to the same status semantics that signal "try again":
      const reason = err.message || 'pair_publish_failed';
      const status =
        reason === 'bridge_not_connected' || reason === 'bridge_handshake_incomplete'
          ? 503 : 502;
      return writeJson(res, status, { error: reason });
    }
    return writeJson(res, 200, {
      code,
      expiresInSec: Math.floor(PAIR_TTL_MS / 1000),
    });
  }

  // POST /resync-state — force a synthetic-ChangeReport burst for every
  // exposed endpoint, using whatever's currently in the state-cache. Two
  // use cases:
  //   1. Bootstrapping Alexa's view of stable properties that never change
  //      (operatingMode on a thermostat, source on an idle audio zone, etc.)
  //      Alexa only learns properties via ChangeReport when they actually
  //      change; if a property never changes, Alexa never sees it.
  //   2. Recovery when Alexa's state drifts (Lambda failure, gateway
  //      timeout, etc.) and the user wants to force a resync without
  //      restarting the daemon.
  //
  // Idempotent: re-running is harmless. Returns { dispatched, total } so
  // the caller can confirm something actually went out.
  async postResyncState(res) {
    if (!this.stateReporter || typeof this.stateReporter.dispatchSnapshot !== 'function') {
      return writeJson(res, 503, { error: 'state_reporter_unavailable' });
    }
    let result;
    try {
      result = await this.stateReporter.dispatchSnapshot();
    } catch (err) {
      this.log.warn({ err: err.message }, '/resync-state dispatch failed');
      return writeJson(res, 500, { error: 'snapshot_failed', message: err.message });
    }
    this.log.info(result, '/resync-state completed');
    return writeJson(res, 200, { ok: true, ...result });
  }

  async postResetPairings(_req, res) {
    // Rotate identity files on disk, swap the in-memory ref, force a fresh
    // bridge connection so the new userId is presented. Existing DDB rows
    // for the old userId become orphans (bridge will 504 dispatch attempts).
    const before = this.identityRef.current.userId;
    const next = identity.rotate({
      identityDir: this.identityRef.identityDir,
      log: this.log,
    });
    this.identityRef.current = next;
    this.log.warn({ before, after: next.userId }, 'identity rotated by user request');

    // The observed pairings table now points at orphaned DDB rows. Wipe it.
    if (this.pairings) {
      await this.pairings.clear().catch((err) =>
        this.log.warn({ err: err.message }, 'pairings.clear failed'));
    }

    if (this.bridgeClient) {
      this.bridgeClient.forceReconnect('identity rotated');
    }
    return writeJson(res, 200, {
      ok: true,
      userId: next.userId,
      note: 'all existing Alexa account links are now stale — re-link in the Alexa app',
    });
  }
}

module.exports = { LocalHttpServer };
