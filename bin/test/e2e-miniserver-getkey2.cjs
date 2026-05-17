#!/usr/bin/env node
// Step 5d.2 end-to-end: keyexchange → encrypted getkey2 round-trip.
// Run on the LoxBerry. Uses the user account from LoxBerry config.
// Output is credential-free: only field shapes and lengths are printed.
'use strict';

const crypto = require('node:crypto');
const { loadWithCredentials } = require('../src/miniserver-config');
const { fetchPublicKey } = require('../src/miniserver-probe');
const { MiniserverWsClient } = require('../src/miniserver-ws');

const log = {
  debug(o, m) { console.log('DEBUG', m, o); },
  info(o, m)  { console.log('INFO',  m, o); },
  warn(o, m)  { console.log('WARN',  m, o); },
  error(o, m) { console.log('ERROR', m, o); },
  child() { return this; },
};

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }

(async () => {
  const [ms] = await loadWithCredentials();
  const { username } = ms.getCredentialsForAuth();
  const pem = await fetchPublicKey(ms);
  const publicKey = crypto.createPublicKey(pem);

  console.log(`# connecting to ${ms.wsBase()}/ws/rfc6455`);
  const client = new MiniserverWsClient({ msConfig: ms, publicKey, log });

  try {
    await client.start();
    ok('keyexchange completed');

    // Send encrypted getkey2 for our user. Response value is encrypted JSON
    // containing key (hex), salt (hex), hashAlg ('SHA1' or 'SHA256').
    const response = await client.sendEncrypted(`jdev/sys/getkey2/${username}`);
    const code = response?.LL?.Code;
    check(code === '200' || code === 200, `getkey2 Code is 200 (got ${code})`);

    const value = response?.LL?.value;
    check(value && typeof value === 'object', 'value decrypted to JSON object');
    if (value) {
      check(typeof value.key === 'string' && value.key.length > 0,    `key field present (length=${value.key?.length})`);
      check(typeof value.salt === 'string' && value.salt.length > 0,  `salt field present (length=${value.salt?.length})`);
      check(typeof value.hashAlg === 'string',                        'hashAlg present');
      check(['SHA1', 'SHA256'].includes(value.hashAlg),               `hashAlg is SHA1/SHA256 (got ${value.hashAlg})`);
      // Lightly sanity-check that key/salt look like hex.
      check(/^[0-9a-fA-F]+$/.test(value.key || ''),                   'key looks hex');
      check(/^[0-9a-fA-F]+$/.test(value.salt || ''),                  'salt looks hex');
      console.log(`  (key.length=${value.key.length}  salt.length=${value.salt.length}  hashAlg=${value.hashAlg})`);
    }
  } catch (err) {
    nope('flow threw', err.message);
  } finally {
    await client.stop();
  }

  await new Promise((r) => setTimeout(r, 300));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`\nfatal: ${err.message}`);
  process.exit(1);
});
