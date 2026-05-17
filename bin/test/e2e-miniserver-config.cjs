#!/usr/bin/env node
// End-to-end: real lox-getconfig.pl → real LoxBerry::System → JSON → Node.
// Runs on the LoxBerry. Strict about NEVER printing credential values —
// only type/shape assertions are emitted.
'use strict';

const { load, loadWithCredentials } = require('../src/miniserver-config');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label) { console.log(`  ✗ ${label}`); fail++; }
function check(cond, label) { (cond ? ok : nope)(label); }

(async () => {
  console.log('# default mode (no creds)');
  const safe = await load();
  check(Array.isArray(safe),                          'returns an array');
  check(safe.length >= 1,                             'at least one miniserver');
  const ms0 = safe[0];
  check(typeof ms0.msNo === 'number',                 'msNo is number');
  check(typeof ms0.name === 'string' && ms0.name.length > 0, 'name is non-empty string');
  check(typeof ms0.host === 'string' && ms0.host.length > 0, 'host is non-empty string');
  check(typeof ms0.preferHttps === 'boolean',         'preferHttps is boolean');
  check(ms0.hasCredentials() === false,               'no credentials in default mode');
  check(ms0.httpsBase().startsWith('http'),           'httpsBase composes a URL');
  check(ms0.wsBase().startsWith('ws'),                'wsBase composes a URL');
  console.log(`  (public summary: ${JSON.stringify(ms0)})`);

  console.log('\n# with-credentials mode');
  const creds = await loadWithCredentials();
  const c0 = creds[0];
  check(c0.hasCredentials() === true,                 'hasCredentials true');
  const auth = c0.getCredentialsForAuth();
  check(typeof auth.username === 'string' && auth.username.length > 0, 'username present (length > 0)');
  check(typeof auth.password === 'string' && auth.password.length > 0, 'password present (length > 0)');
  // Confirm JSON.stringify-style serialization (logger inline format) doesn't leak.
  const serialised = JSON.stringify(c0);
  check(!serialised.includes(auth.password),          'password NOT in JSON.stringify output');
  check(!serialised.includes(auth.username),          'username NOT in JSON.stringify output');
  // Sanity check: this is the SAME Miniserver as in default mode.
  check(c0.msNo === ms0.msNo,                         'msNo matches default-mode entry');
  check(c0.host === ms0.host,                         'host matches default-mode entry');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`\nfatal: ${err.message}`);
  process.exit(1);
});
