#!/usr/bin/env node
// Unit tests for MiniserverTokenStore + daemon-uuid.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MiniserverTokenStore, readTokenSync, LOXONE_EPOCH_MS, SECONDS_PER_DAY } = require('../src/miniserver-token-store');
const { loadOrCreate, generate } = require('../src/daemon-uuid');

const log = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return this; },
};

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }
function eq(a, b, label) { check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function test(name, fn) {
  console.log(`# ${name}`);
  try { await fn(); } catch (e) { nope('threw', e.stack || e.message); }
  console.log('');
}

function tmpDir(label) {
  const d = path.join(os.tmpdir(), `aloxberry-tokenstore-${label}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function rm(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

// Build a token whose validUntil is `daysFromNow` days in the future.
function makeToken({ daysFromNow = 30, snr = 'AA:BB:CC', username = 'u' } = {}) {
  const epochSec = Math.floor((Date.now() - LOXONE_EPOCH_MS) / 1000);
  return {
    snr, username,
    token: 'fake.jwt.token',
    key: 'deadbeefcafebabe',
    validUntil: epochSec + daysFromNow * SECONDS_PER_DAY,
  };
}

(async () => {
  await test('daemon-uuid: generate produces 8-4-4-16 hex format', () => {
    const u = generate();
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/.test(u), `format ${u}`);
  });

  await test('daemon-uuid: loadOrCreate persists across calls', () => {
    const d = tmpDir('daemon-uuid');
    try {
      const u1 = loadOrCreate(d);
      const u2 = loadOrCreate(d);
      eq(u1, u2, 'second call returns the same UUID');
      check(fs.existsSync(path.join(d, 'daemon-uuid')), 'file persisted');
    } finally { rm(d); }
  });

  await test('daemon-uuid: loadOrCreate rewrites malformed file', () => {
    const d = tmpDir('daemon-uuid-bad');
    try {
      fs.writeFileSync(path.join(d, 'daemon-uuid'), 'not-a-uuid');
      const u = loadOrCreate(d);
      check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/.test(u), 'returns valid UUID');
    } finally { rm(d); }
  });

  await test('save+load round-trip preserves fields', async () => {
    const d = tmpDir('save-load');
    try {
      const store = new MiniserverTokenStore({ dataDir: d, log });
      const t = makeToken({ snr: 'X:Y', username: 'admin' });
      await store.save(t);
      const back = await store.load({ expectedSnr: 'X:Y', expectedUsername: 'admin' });
      check(back !== null, 'loaded back');
      eq(back.token, t.token, 'token');
      eq(back.key, t.key, 'key');
      eq(back.validUntil, t.validUntil, 'validUntil');
      eq(back.snr, t.snr, 'snr');
      eq(back.username, t.username, 'username');
      check(typeof back.savedAt === 'string', 'savedAt timestamp added');
    } finally { rm(d); }
  });

  await test('load returns null when file missing', async () => {
    const d = tmpDir('missing');
    try {
      const store = new MiniserverTokenStore({ dataDir: d, log });
      eq(await store.load(), null, 'null on missing');
    } finally { rm(d); }
  });

  await test('load discards file with mismatched SNR', async () => {
    const d = tmpDir('snr-mismatch');
    try {
      const store = new MiniserverTokenStore({ dataDir: d, log });
      await store.save(makeToken({ snr: 'old-snr' }));
      const back = await store.load({ expectedSnr: 'new-snr' });
      eq(back, null, 'null on SNR mismatch');
    } finally { rm(d); }
  });

  await test('load discards file with mismatched username', async () => {
    const d = tmpDir('user-mismatch');
    try {
      const store = new MiniserverTokenStore({ dataDir: d, log });
      await store.save(makeToken({ username: 'olduser' }));
      const back = await store.load({ expectedUsername: 'newuser' });
      eq(back, null, 'null on username mismatch');
    } finally { rm(d); }
  });

  await test('load discards expired token', async () => {
    const d = tmpDir('expired');
    try {
      const store = new MiniserverTokenStore({ dataDir: d, log });
      await store.save(makeToken({ daysFromNow: -1 }));   // already expired
      const back = await store.load();
      eq(back, null, 'null on expired');
    } finally { rm(d); }
  });

  await test('load discards malformed JSON file', async () => {
    const d = tmpDir('malformed');
    try {
      fs.writeFileSync(path.join(d, 'miniserver-token.json'), 'this is not json {{{');
      const store = new MiniserverTokenStore({ dataDir: d, log });
      eq(await store.load(), null, 'null on bad JSON');
      check(!fs.existsSync(path.join(d, 'miniserver-token.json')), 'malformed file removed');
    } finally { rm(d); }
  });

  await test('isExpired + expiresWithinSeconds', async () => {
    const d = tmpDir('expiry-math');
    try {
      const store = new MiniserverTokenStore({ dataDir: d, log });
      const future = makeToken({ daysFromNow: 30 });
      const past = makeToken({ daysFromNow: -1 });
      eq(store.isExpired(future), false, 'future token not expired');
      eq(store.isExpired(past), true, 'past token expired');
      eq(store.expiresWithinSeconds(future, 60), false, '30 days > 60s');
      eq(store.expiresWithinSeconds(future, 31 * SECONDS_PER_DAY), true, '30 days < 31 days');
    } finally { rm(d); }
  });

  await test('save uses chmod 600 on the file', async () => {
    if (process.platform === 'win32') {
      ok('skipped on Windows (no POSIX chmod)');
      return;
    }
    const d = tmpDir('chmod');
    try {
      const store = new MiniserverTokenStore({ dataDir: d, log });
      await store.save(makeToken());
      const stat = fs.statSync(path.join(d, 'miniserver-token.json'));
      const mode = stat.mode & 0o777;
      eq(mode, 0o600, `mode is 0o600 (got 0o${mode.toString(8)})`);
    } finally { rm(d); }
  });

  await test('clear removes the file', async () => {
    const d = tmpDir('clear');
    try {
      const store = new MiniserverTokenStore({ dataDir: d, log });
      await store.save(makeToken());
      await store.clear();
      eq(readTokenSync(d), null, 'file gone');
    } finally { rm(d); }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
