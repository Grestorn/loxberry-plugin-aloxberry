#!/usr/bin/env node
// Unit tests for MiniserverConfig — uses mock-lox-getconfig.cjs, no LoxBerry needed.
'use strict';

const path = require('node:path');
const util = require('node:util');
const { load, loadWithCredentials, MiniserverConfig } = require('../src/miniserver-config');

const MOCK = path.join(__dirname, 'mock-lox-getconfig.cjs');
const COMMON = { scriptPath: MOCK, executable: 'node', timeoutMs: 2000 };

let pass = 0, fail = 0;

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

function assertTrue(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else      { console.log(`  ✗ ${label}: was falsy`); fail++; }
}

async function test(name, fn) {
  console.log(`# ${name}`);
  try { await fn(); } catch (err) { console.log(`  ✗ threw: ${err.message}`); fail++; }
  console.log('');
}

(async () => {
  await test('load() returns array of MiniserverConfig, no creds', async () => {
    const all = await load(COMMON);
    assertEqual(all.length, 2, 'two miniservers');
    assertTrue(all[0] instanceof MiniserverConfig, 'instance type');
    assertEqual(all[0].name, 'MainMS', 'name');
    assertEqual(all[0].hasCredentials(), false, 'hasCredentials');
    let threw = false;
    try { all[0].getCredentialsForAuth(); } catch { threw = true; }
    assertTrue(threw, 'getCredentialsForAuth throws when no creds');
  });

  await test('loadWithCredentials() includes creds', async () => {
    const all = await loadWithCredentials(COMMON);
    assertEqual(all[0].hasCredentials(), true, 'hasCredentials');
    const c = all[0].getCredentialsForAuth();
    assertEqual(c.username, 'admin', 'username');
    assertEqual(c.password, 'mock-password-do-not-log', 'password');
  });

  await test('toJSON / JSON.stringify does NOT leak password', async () => {
    const all = await loadWithCredentials(COMMON);
    const dump = JSON.stringify(all[0]);
    assertTrue(!dump.includes('mock-password-do-not-log'), 'password not in JSON');
    assertTrue(dump.includes('"hasCredentials":true'), 'hasCredentials flag present');
    assertTrue(dump.includes('"name":"MainMS"'), 'public fields present');
  });

  await test('util.inspect does NOT leak password', async () => {
    const all = await loadWithCredentials(COMMON);
    const dump = util.inspect(all[0]);
    assertTrue(!dump.includes('mock-password-do-not-log'), 'password not in inspect output');
  });

  await test('httpsBase / wsBase URL composition', async () => {
    const all = await load(COMMON);
    assertEqual(all[0].httpsBase(), 'https://miniserver.test:443', 'https for preferHttps=true');
    assertEqual(all[0].wsBase(),    'wss://miniserver.test:443',   'wss for preferHttps=true');
    assertEqual(all[1].httpsBase(), 'http://guest.test:80',        'http for preferHttps=false + scheme=http');
    assertEqual(all[1].wsBase(),    'ws://guest.test:80',          'ws for preferHttps=false + scheme=http');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
