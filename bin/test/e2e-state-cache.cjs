#!/usr/bin/env node
// Step 5f end-to-end: events → decoder → state cache, verified against the
// live Miniserver's initial dump. No UUIDs or values printed — privacy-safe.
'use strict';

const crypto = require('node:crypto');
const { loadWithCredentials } = require('../src/miniserver-config');
const { fetchPublicKey } = require('../src/miniserver-probe');
const { MiniserverWsClient } = require('../src/miniserver-ws');
const { decodeEventPayload } = require('../src/miniserver-events');
const { MiniserverStateCache } = require('../src/state-cache');
const c = require('../src/miniserver-crypto');

const log = {
  debug() {}, info() {}, warn(o, m) { console.log('WARN', m, o ?? ''); },
  error(o, m) { console.log('ERROR', m, o ?? ''); },
  child() { return this; },
};

const DAEMON_UUID = '6c6f7868-6f6d-6500-616c6578612d6873';
const CLIENT_INFO = encodeURIComponent('aloxberry-daemon');
const PERMISSION_APP = 4;
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

  const client = new MiniserverWsClient({ msConfig: ms, publicKey, log });
  const cache = new MiniserverStateCache();

  client.on('binary-payload', ({ identifier, data }) => {
    const decoded = decodeEventPayload(identifier, data);
    cache.ingest(decoded);
  });

  console.log('# auth + subscribe + ingest events into state cache');
  await client.start();
  const k2 = await client.sendEncrypted(`jdev/sys/getkey2/${username}`);
  const { key, salt, hashAlg } = k2.LL.value;
  const pwHash = c.passwordHash(password, salt, hashAlg);
  const hash = c.userHmac(key, username, pwHash, hashAlg);
  const jwt = await client.sendEncrypted(
    `jdev/sys/getjwt/${hash}/${username}/${PERMISSION_APP}/${DAEMON_UUID}/${CLIENT_INFO}`,
  );
  check(jwt?.LL?.Code === '200', 'JWT acquired');

  await client.subscribeBinaryEvents();
  ok('subscribed');

  await new Promise((r) => setTimeout(r, OBSERVE_MS));

  const summary = cache.snapshotSummary();
  console.log('\n# cache.snapshotSummary():');
  console.log(`  ${JSON.stringify(summary)}`);

  check(summary.valueCount > 100, `value cache populated (${summary.valueCount} entries)`);
  check(summary.textCount > 10, `text cache populated (${summary.textCount} entries)`);
  check(summary.eventsSeen >= summary.valueCount + summary.textCount,
        'eventsSeen ≥ value+text counts (daytimer/weather may add more)');
  check(summary.lastEventAt !== null, 'lastEventAt set');
  check(new Date(summary.lastEventAt).getTime() > 0, 'lastEventAt parses as a real date');

  // Sanity: pick one value-UUID we observed and confirm we can read it back.
  // We don't know the UUIDs ahead of time, so iterate the cache to grab one.
  const firstUuid = cache.values.keys().next().value;
  if (firstUuid) {
    const entry = cache.getValue(firstUuid);
    check(typeof entry.value === 'number', 'sample entry: value is a number');
    check(typeof entry.updatedAt === 'number', 'sample entry: updatedAt is ms timestamp');
  }

  await client.stop();
  await new Promise((r) => setTimeout(r, 200));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`\nfatal: ${err.message}`);
  process.exit(1);
});
