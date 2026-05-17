#!/usr/bin/env node
// Unit tests for bin/src/identity.js — persistent userId + skillSecret files.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const identity = require('../src/identity');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }
function eq(a, b, label) { check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function test(name, fn) {
  console.log(`# ${name}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aloxberry-id-'));
  try { fn(dir); }
  catch (e) { nope('threw', e.stack || e.message); }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('');
}

const silentLog = { info() {}, warn() {} };

test('first call generates both files', (dir) => {
  const r = identity.loadOrCreate({ identityDir: dir, log: silentLog });
  check(identity.USER_ID_RE.test(r.userId), 'userId matches shape', r.userId);
  check(identity.SKILL_SECRET_RE.test(r.skillSecret), 'skillSecret hex shape');
  eq(r.skillSecretBytes.length, 32, 'skillSecret is 32 bytes');
  eq(r.wasCreated, true, 'wasCreated=true');
  check(fs.existsSync(path.join(dir, 'userId')), 'userId file persisted');
  check(fs.existsSync(path.join(dir, 'skillSecret')), 'skillSecret file persisted');
});

test('second call returns same identity', (dir) => {
  const a = identity.loadOrCreate({ identityDir: dir, log: silentLog });
  const b = identity.loadOrCreate({ identityDir: dir, log: silentLog });
  eq(b.userId, a.userId, 'userId stable across reads');
  eq(b.skillSecret, a.skillSecret, 'skillSecret stable across reads');
  eq(b.wasCreated, false, 'second call: wasCreated=false');
});

test('rotate yields different values', (dir) => {
  const a = identity.loadOrCreate({ identityDir: dir, log: silentLog });
  const b = identity.rotate({ identityDir: dir, log: silentLog });
  check(a.userId !== b.userId, 'userId changed');
  check(a.skillSecret !== b.skillSecret, 'skillSecret changed');
  // Re-reading from disk yields the rotated values.
  const c = identity.loadOrCreate({ identityDir: dir, log: silentLog });
  eq(c.userId, b.userId, 'rotated userId persisted');
});

test('corrupt files are regenerated, not used', (dir) => {
  fs.writeFileSync(path.join(dir, 'userId'), 'not-base64url-junk!@#');
  fs.writeFileSync(path.join(dir, 'skillSecret'), 'not-hex-zzzz');
  const r = identity.loadOrCreate({ identityDir: dir, log: silentLog });
  check(identity.USER_ID_RE.test(r.userId), 'userId regenerated');
  check(identity.SKILL_SECRET_RE.test(r.skillSecret), 'skillSecret regenerated');
});

test('partial state (only userId present) generates missing half', (dir) => {
  const seedUid = identity.generateUserId();
  fs.writeFileSync(path.join(dir, 'userId'), seedUid);
  const r = identity.loadOrCreate({ identityDir: dir, log: silentLog });
  eq(r.userId, seedUid, 'kept existing userId');
  check(identity.SKILL_SECRET_RE.test(r.skillSecret), 'generated missing skillSecret');
});

test('files written with restrictive perms (POSIX only)', (dir) => {
  if (process.platform === 'win32') { ok('skipped on win32'); return; }
  identity.loadOrCreate({ identityDir: dir, log: silentLog });
  const skillMode = fs.statSync(path.join(dir, 'skillSecret')).mode & 0o777;
  eq(skillMode, 0o600, 'skillSecret is 0600');
  const uidMode = fs.statSync(path.join(dir, 'userId')).mode & 0o777;
  eq(uidMode, 0o600, 'userId is 0600');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
