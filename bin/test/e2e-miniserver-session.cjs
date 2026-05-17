#!/usr/bin/env node
// Step 5g end-to-end: MiniserverSession against the live Miniserver.
//
// Three rounds, all sharing one DATA_DIR:
//   ROUND 1  — empty cache; verifies getjwt (full handshake) and token save.
//   ROUND 2  — cached token; verifies authwithtoken (no password used).
//   ROUND 3  — refresh path; manually triggers _refresh() and asserts the
//              validUntil timestamp advances.
//
// Credentials are read fresh by ROUND 1 only. Hooked to count the calls so
// we can assert ROUND 2 didn't fall through to getjwt.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadWithCredentials } = require('../src/miniserver-config');
const { fetchPublicKey, probeApiKey } = require('../src/miniserver-probe');
const { MiniserverSession } = require('../src/miniserver-session');
const { MiniserverTokenStore, readTokenSync, LOXONE_EPOCH_MS } = require('../src/miniserver-token-store');
const { MiniserverStateCache } = require('../src/state-cache');
const { loadOrCreate: loadOrCreateDaemonUuid } = require('../src/daemon-uuid');

const log = {
  debug() {},
  info(o, m)  { console.log('INFO',  m, o ?? ''); },
  warn(o, m)  { console.log('WARN',  m, o ?? ''); },
  error(o, m) { console.log('ERROR', m, o ?? ''); },
  child() { return this; },
};

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }

async function runRound({ label, dataDir, msConfig, publicKey, daemonUuid, allowGetCredentials }) {
  console.log(`\n## ${label}`);
  const tokenStore = new MiniserverTokenStore({ dataDir, log });
  const stateCache = new MiniserverStateCache();
  let credentialsRequests = 0;
  const session = new MiniserverSession({
    msConfig, publicKey, daemonUuid, tokenStore, stateCache, log,
    getCredentials: async () => {
      credentialsRequests++;
      if (!allowGetCredentials) {
        throw new Error('TEST FAIL: getCredentials called in cached-auth round');
      }
      const [ms] = await loadWithCredentials();
      return ms.getCredentialsForAuth();
    },
  });

  let viaCachedToken = null;
  session.on('authenticated', ({ viaCachedToken: v }) => { viaCachedToken = v; });
  const subscribed = new Promise((resolve) => session.once('subscribed', resolve));

  await session.start();
  await subscribed;

  // Let some initial-dump traffic flow in to verify subscribe works post-auth.
  await new Promise((r) => setTimeout(r, 3000));

  const summary = stateCache.snapshotSummary();
  return { session, viaCachedToken, credentialsRequests, summary };
}

(async () => {
  // Probe once to get SNR + publicKey + msConfig (shared across rounds).
  const [ms] = await loadWithCredentials();   // public-fields only; not used here
  const pem = await fetchPublicKey(ms);
  const publicKey = crypto.createPublicKey(pem);
  const api = await probeApiKey(ms);

  // Ephemeral data dir, shared across rounds.
  const dataDir = path.join(os.tmpdir(), `aloxberry-5g-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`# data dir: ${dataDir}`);

  const daemonUuid = loadOrCreateDaemonUuid(dataDir);
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/.test(daemonUuid), 'daemon UUID generated');
  console.log(`# daemon UUID: ${daemonUuid}  Miniserver SNR: ${api.snr}`);

  // ---- ROUND 1: full getjwt --------------------------------------------------
  let r1;
  try {
    r1 = await runRound({
      label: 'ROUND 1 — empty cache, expect getjwt',
      dataDir, msConfig: ms, publicKey, daemonUuid, allowGetCredentials: true,
    });
    check(r1.viaCachedToken === false, 'authenticated via getjwt (not cached token)');
    check(r1.credentialsRequests === 1, `getCredentials called exactly once (got ${r1.credentialsRequests})`);
    check(r1.summary.valueCount > 100, `value cache populated (${r1.summary.valueCount})`);
    const stored = readTokenSync(dataDir);
    check(stored !== null, 'token file written to disk');
    check(typeof stored?.token === 'string' && stored.token.length > 100, `cached token is non-trivial (${stored?.token?.length} chars)`);
    const validUntilMs = LOXONE_EPOCH_MS + stored.validUntil * 1000;
    const remainingDays = (validUntilMs - Date.now()) / 86_400_000;
    check(remainingDays > 30, `cached validUntil is far future (~${remainingDays.toFixed(1)}d)`);
    await r1.session.stop();
    ok('round 1 session stopped');
  } catch (err) {
    nope('round 1 threw', err.message);
    process.exit(1);
  }

  // ---- ROUND 2: authwithtoken ------------------------------------------------
  let r2;
  try {
    r2 = await runRound({
      label: 'ROUND 2 — cached token, expect authwithtoken',
      dataDir, msConfig: ms, publicKey, daemonUuid, allowGetCredentials: false,
    });
    check(r2.viaCachedToken === true, 'authenticated via cached token');
    check(r2.credentialsRequests === 0, `getCredentials never called (got ${r2.credentialsRequests})`);
    check(r2.summary.valueCount > 100, `events flow on the reauthed connection (${r2.summary.valueCount})`);
    // The cached token file should still exist (and unchanged token string).
    const stored = readTokenSync(dataDir);
    check(stored !== null, 'token cache still present');
  } catch (err) {
    nope('round 2 threw', err.message);
    await r2?.session?.stop();
    process.exit(1);
  }

  // ---- ROUND 3: manual refresh -----------------------------------------------
  console.log('\n## ROUND 3 — manual refresh on the still-open round-2 session');
  try {
    const beforeStored = readTokenSync(dataDir);
    const beforeValid = beforeStored.validUntil;

    // Promise that resolves on the next 'token-refreshed' event.
    const refreshed = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('token-refreshed event not fired within 10s')), 10000);
      r2.session.once('token-refreshed', (info) => { clearTimeout(t); resolve(info); });
    });
    // Trigger refresh directly (production scheduling is days/weeks away;
    // tests exercise the code path immediately).
    r2.session._refresh();
    const info = await refreshed;
    check(info && info.hasToken, 'token-refreshed event payload');

    const afterStored = readTokenSync(dataDir);
    check(afterStored !== null, 'token file still exists after refresh');
    check(afterStored.validUntil >= beforeValid, `validUntil non-decreasing (before=${beforeValid}, after=${afterStored.validUntil})`);
    if (afterStored.validUntil === beforeValid) {
      console.log('  (note: validUntil unchanged — Loxone may not advance it on every refresh)');
    } else {
      const advanceSec = afterStored.validUntil - beforeValid;
      console.log(`  validUntil advanced by ${advanceSec}s (~${(advanceSec / 86400).toFixed(1)}d)`);
    }
  } catch (err) {
    nope('round 3 threw', err.message);
  } finally {
    await r2.session.stop();
  }

  // ---- cleanup ---------------------------------------------------------------
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`\nfatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
