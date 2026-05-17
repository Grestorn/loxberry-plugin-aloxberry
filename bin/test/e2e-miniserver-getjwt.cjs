#!/usr/bin/env node
// Step 5d.3 end-to-end: full token acquisition.
//   keyexchange → getkey2 → hash(password,salt) → HMAC(key,user:pwHash) → getjwt
// Output is credential-free: token printed only as length, not value.
'use strict';

const crypto = require('node:crypto');
const { loadWithCredentials } = require('../src/miniserver-config');
const { fetchPublicKey } = require('../src/miniserver-probe');
const { MiniserverWsClient } = require('../src/miniserver-ws');
const c = require('../src/miniserver-crypto');

const log = {
  debug(o, m) {},  // suppress debug noise for this test
  info(o, m)  { console.log('INFO',  m, o); },
  warn(o, m)  { console.log('WARN',  m, o); },
  error(o, m) { console.log('ERROR', m, o); },
  child() { return this; },
};

// Loxone uses a non-RFC UUID shape: 8-4-4-16 hex chars (only 3 hyphens).
// In the daemon proper we'll generate this once at install time and persist
// it. For this test a fixed string is fine.
const DAEMON_UUID = '6c6f7868-6f6d-6500-616c6578612d6873';  // "loxh-ome-\0\0\0-alexa-hs"
const CLIENT_INFO = encodeURIComponent('aloxberry-daemon');
const PERMISSION_APP = 4;

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }

// Loxone validUntil epoch: seconds since 2009-01-01 UTC.
const LOXONE_EPOCH_MS = Date.UTC(2009, 0, 1);
const loxoneEpochToIso = (s) => new Date(LOXONE_EPOCH_MS + s * 1000).toISOString();

(async () => {
  const [ms] = await loadWithCredentials();
  const { username, password } = ms.getCredentialsForAuth();
  const pem = await fetchPublicKey(ms);
  const publicKey = crypto.createPublicKey(pem);

  console.log(`# acquiring JWT for user "${username}" from ${ms.host}`);
  const client = new MiniserverWsClient({ msConfig: ms, publicKey, log });

  try {
    await client.start();
    ok('keyexchange done');

    // Phase 5: getkey2 → key, salt, hashAlg
    const k2 = await client.sendEncrypted(`jdev/sys/getkey2/${username}`);
    check(k2?.LL?.Code === '200', 'getkey2 Code 200');
    const { key, salt, hashAlg } = k2.LL.value;
    check(typeof key === 'string' && key.length > 0, 'key present');
    check(typeof salt === 'string' && salt.length > 0, 'salt present');
    check(['SHA1', 'SHA256'].includes(hashAlg), `hashAlg ${hashAlg}`);

    // Phase 6: compute pwHash and hash
    const pwHash = c.passwordHash(password, salt, hashAlg);
    const hash = c.userHmac(key, username, pwHash, hashAlg);
    check(/^[0-9a-fA-F]+$/.test(hash), 'hash is hex');
    check(hash.length === (hashAlg === 'SHA256' ? 64 : 40), `hash length matches ${hashAlg}`);

    // Phase 7: getjwt
    const inner = `jdev/sys/getjwt/${hash}/${username}/${PERMISSION_APP}/${DAEMON_UUID}/${CLIENT_INFO}`;
    const jwt = await client.sendEncrypted(inner);
    check(jwt?.LL?.Code === '200', `getjwt Code 200 (got ${jwt?.LL?.Code})`);
    // On failure, print the response shape WITHOUT any token field (the
    // failure-case payload has no token anyway, but defensive).
    if (jwt?.LL?.Code !== '200') {
      const safeCopy = JSON.parse(JSON.stringify(jwt));
      if (safeCopy?.LL?.value?.token) safeCopy.LL.value.token = '<redacted>';
      console.log('  response (failure):', JSON.stringify(safeCopy, null, 2).slice(0, 600));
    }
    const v = jwt?.LL?.value;
    check(v && typeof v === 'object', 'getjwt value is object');
    if (v) {
      check(typeof v.token === 'string' && v.token.length > 0,
            `token present (length=${v.token?.length})`);
      check(typeof v.key === 'string' && v.key.length > 0,
            `new HMAC key present (length=${v.key?.length})`);
      check(typeof v.validUntil === 'number',
            `validUntil is a number`);
      // tokenRights is a BITMAP of all permissions granted, not the requested
      // one. Verify the App bit (0x4) is set; other bits indicate additional
      // permissions the user account holds.
      check((v.tokenRights & PERMISSION_APP) === PERMISSION_APP,
            `App bit set in tokenRights bitmap (got ${v.tokenRights} = 0x${v.tokenRights.toString(16)})`);
      check(typeof v.unsecurePass === 'boolean',
            `unsecurePass present (${v.unsecurePass})`);

      // Convert validUntil to a readable date — useful sanity check.
      if (typeof v.validUntil === 'number') {
        const iso = loxoneEpochToIso(v.validUntil);
        const daysFromNow = (new Date(iso).getTime() - Date.now()) / 86400000;
        check(daysFromNow > 0, `token expires in the future (${iso}, ~${daysFromNow.toFixed(1)} days)`);
        check(daysFromNow > 1, 'token is long-lived (>1 day, expected ~weeks for App permission)');
      }
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
