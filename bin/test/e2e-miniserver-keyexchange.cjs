#!/usr/bin/env node
// Step 5d.1 end-to-end: WSS + RSA key exchange against real Miniserver.
// Run on the LoxBerry. No credentials used — keyexchange is unauthenticated.
'use strict';

const { load } = require('../src/miniserver-config');
const { fetchPublicKey } = require('../src/miniserver-probe');
const { MiniserverWsClient } = require('../src/miniserver-ws');
const crypto = require('node:crypto');

const log = {
  debug(o, m) { console.log('DEBUG', m, o); },
  info(o, m)  { console.log('INFO',  m, o); },
  warn(o, m)  { console.log('WARN',  m, o); },
  error(o, m) { console.log('ERROR', m, o); },
  child() { return this; },
};

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, detail) { console.log(`  ✗ ${label}${detail ? ': ' + detail : ''}`); fail++; }
function check(cond, label, detail) { (cond ? ok : nope)(label, detail); }

(async () => {
  const [ms] = await load();
  const pem = await fetchPublicKey(ms);
  const publicKey = crypto.createPublicKey(pem);

  console.log(`\n# connecting to ${ms.wsBase()}/ws/rfc6455`);
  const client = new MiniserverWsClient({ msConfig: ms, publicKey, log });

  try {
    await client.start();
    ok('keyexchange completed without throwing');
    check(client.aesSession != null, 'AES session established');
    check(client.aesSession.aesKey?.length === 32, 'aesKey is 32 bytes');
    check(client.aesSession.aesIv?.length === 16, 'aesIv is 16 bytes');
  } catch (err) {
    nope('start() threw', err.message);
  } finally {
    await client.stop();
    ok('client.stop() returned');
  }

  // Brief settle to let the close round-trip.
  await new Promise((r) => setTimeout(r, 500));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`\nfatal: ${err.message}`);
  process.exit(1);
});
