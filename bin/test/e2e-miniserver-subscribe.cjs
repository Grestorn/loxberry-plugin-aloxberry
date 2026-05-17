#!/usr/bin/env node
// Step 5d.4 end-to-end: full auth + subscribe + watch event traffic.
//   keyexchange → getkey2 → getjwt → enablebinstatusupdate → listen
//
// Run with LOG_RAW_EVENTS=1 to hex-dump frames (corpus for the decoder).
// Run with LOG_RAW_EVENTS unset to just get the count summary.
//
// Captures events for ~5 seconds, then closes cleanly.
'use strict';

const crypto = require('node:crypto');
const { loadWithCredentials } = require('../src/miniserver-config');
const { fetchPublicKey } = require('../src/miniserver-probe');
const { MiniserverWsClient } = require('../src/miniserver-ws');
const c = require('../src/miniserver-crypto');

const log = {
  debug() {},  // silent
  info(o, m)  { console.log('INFO',  m, o ?? ''); },
  warn(o, m)  { console.log('WARN',  m, o ?? ''); },
  error(o, m) { console.log('ERROR', m, o ?? ''); },
  child() { return this; },
};

// Same UUID + info constants used in step 5d.3.
const DAEMON_UUID = '6c6f7868-6f6d-6500-616c6578612d6873';
const CLIENT_INFO = encodeURIComponent('aloxberry-daemon');
const PERMISSION_APP = 4;
const ID_NAMES = {
  0: 'TEXT', 1: 'BINARY_FILE', 2: 'VALUE_EVENTS', 3: 'TEXT_EVENTS',
  4: 'DAYTIMER_EVENTS', 5: 'OUT_OF_SERVICE', 6: 'KEEPALIVE', 7: 'WEATHER_EVENTS',
};

const OBSERVE_MS = 5000;

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }

(async () => {
  const [ms] = await loadWithCredentials();
  const { username, password } = ms.getCredentialsForAuth();
  const pem = await fetchPublicKey(ms);
  const publicKey = crypto.createPublicKey(pem);

  console.log(`# subscribing on ${ms.host} as ${username}`);
  const client = new MiniserverWsClient({ msConfig: ms, publicKey, log });

  // ----- Phase 0-7: handshake → JWT (reuses what 5d.3 verified) -----
  await client.start();
  const k2 = await client.sendEncrypted(`jdev/sys/getkey2/${username}`);
  const { key, salt, hashAlg } = k2.LL.value;
  const pwHash = c.passwordHash(password, salt, hashAlg);
  const hash = c.userHmac(key, username, pwHash, hashAlg);
  const inner = `jdev/sys/getjwt/${hash}/${username}/${PERMISSION_APP}/${DAEMON_UUID}/${CLIENT_INFO}`;
  const jwt = await client.sendEncrypted(inner);
  check(jwt?.LL?.Code === '200', `JWT acquired (Code ${jwt?.LL?.Code})`);

  // ----- Phase 8: subscribe -----
  const counters = new Map();         // id → count
  const sizeBytes = new Map();        // id → total bytes
  let firstFrameAt = null;
  let lastFrameAt = null;

  client.on('binary-payload', ({ identifier, data }) => {
    counters.set(identifier, (counters.get(identifier) || 0) + 1);
    sizeBytes.set(identifier, (sizeBytes.get(identifier) || 0) + data.length);
    const now = Date.now();
    if (!firstFrameAt) firstFrameAt = now;
    lastFrameAt = now;
  });

  console.log('\n# subscribing to events…');
  await client.subscribeBinaryEvents();
  ok('enablebinstatusupdate accepted');

  // ----- Observe -----
  console.log(`\n# observing for ${OBSERVE_MS / 1000}s…`);
  await new Promise((r) => setTimeout(r, OBSERVE_MS));

  console.log('\n# event traffic summary:');
  if (counters.size === 0) {
    nope('no binary events received during observation window');
  } else {
    ok('at least one binary event received');
    if (firstFrameAt) {
      console.log(`  first frame at +${firstFrameAt - (firstFrameAt - 100)}ms after subscribe (approx)`);
      console.log(`  last frame at  ${lastFrameAt - firstFrameAt}ms after first`);
    }
    for (const [id, n] of [...counters.entries()].sort((a, b) => a[0] - b[0])) {
      const name = ID_NAMES[id] || `UNKNOWN(${id})`;
      const bytes = sizeBytes.get(id) || 0;
      console.log(`  id=${id} ${name.padEnd(15)} count=${n}  bytes=${bytes}`);
    }
  }

  await client.stop();
  await new Promise((r) => setTimeout(r, 200));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`\nfatal: ${err.message}`);
  process.exit(1);
});
