#!/usr/bin/env node
// End-to-end: probe the user's real Miniserver via apiKey + getPublicKey.
// No auth, no creds, no encryption — just the two public endpoints.
'use strict';

const crypto = require('node:crypto');
const { load } = require('../src/miniserver-config');
const { probeApiKey, fetchPublicKey } = require('../src/miniserver-probe');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label) { console.log(`  ✗ ${label}`); fail++; }
function check(cond, label) { (cond ? ok : nope)(label); }

(async () => {
  const [ms] = await load();
  console.log(`# probing ${ms.name} (${ms.host}:${ms.portHttps})`);

  console.log('\n## /jdev/cfg/apiKey');
  const api = await probeApiKey(ms, { timeoutMs: 5000 });
  check(typeof api.snr === 'string' && api.snr.length > 0, 'snr present');
  check(typeof api.version === 'string',                    'version present');
  check([0, 1, 2].includes(api.httpsStatus),                'httpsStatus is 0/1/2');
  check(typeof api.local === 'boolean',                     'local is boolean');
  check(typeof api.isInTrust === 'boolean',                 'isInTrust is boolean');
  console.log(`  snr=${api.snr}  version=${api.version}  ` +
              `httpsStatus=${api.httpsStatus}  local=${api.local}  isInTrust=${api.isInTrust}`);

  console.log('\n## /jdev/sys/getPublicKey');
  const pem = await fetchPublicKey(ms, { timeoutMs: 5000 });
  check(pem.includes('-----BEGIN PUBLIC KEY-----'),         'has BEGIN PUBLIC KEY marker');
  check(pem.includes('-----END PUBLIC KEY-----'),           'has END PUBLIC KEY marker');
  check(!pem.includes('CERTIFICATE'),                       'no leftover CERTIFICATE wording');

  // The real test: does Node's crypto accept this as an RSA public key?
  let pubKey;
  try {
    pubKey = crypto.createPublicKey(pem);
    ok('crypto.createPublicKey accepts the PEM');
  } catch (err) {
    nope(`crypto.createPublicKey rejected: ${err.message}`);
  }

  if (pubKey) {
    const details = pubKey.asymmetricKeyDetails || {};
    check(pubKey.asymmetricKeyType === 'rsa',               'key type is rsa');
    check(typeof details.modulusLength === 'number',        'modulus length reported');
    console.log(`  asymmetricKeyType=${pubKey.asymmetricKeyType}  modulusLength=${details.modulusLength}`);

    // Sanity: encrypt a tiny payload and back. We can't decrypt (private key
    // lives on the Miniserver) but the encrypt call shape proves the key works.
    try {
      const ct = crypto.publicEncrypt(
        { key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from('hello'),
      );
      check(ct.length > 0, `publicEncrypt produced ${ct.length} ciphertext bytes`);
    } catch (err) {
      nope(`publicEncrypt failed: ${err.message}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`\nfatal: ${err.message}`);
  process.exit(1);
});
