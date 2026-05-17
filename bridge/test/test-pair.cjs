#!/usr/bin/env node
// Unit tests for bridge/src/pair.js
'use strict';

const pair = require('../src/pair');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }
function eq(a, b, label) { check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function test(name, fn) {
  console.log(`# ${name}`);
  pair._resetForTests();
  try { fn(); } catch (e) { nope('threw', e.stack || e.message); }
  console.log('');
}

test('store + take returns the entry, deletes on read', () => {
  pair.store('ABC2345678', { userId: 'u1', skillSecret: 'ff'.repeat(32) });
  eq(pair.size(), 1, 'size = 1');
  const got = pair.take('ABC2345678');
  eq(got?.userId, 'u1', 'userId');
  eq(got?.skillSecret, 'ff'.repeat(32), 'skillSecret');
  eq(pair.size(), 0, 'size = 0 after take');
  eq(pair.take('ABC2345678'), null, 'second take is null');
});

test('unknown code → null', () => {
  eq(pair.take('NOTACODE12'), null, 'null');
});

test('non-string code → null', () => {
  eq(pair.take(undefined), null, 'undefined → null');
  eq(pair.take(null), null, 'null → null');
  eq(pair.take(12345), null, 'number → null');
});

test('rejects bad inputs in store()', () => {
  let threw = false;
  try { pair.store('A'.repeat(10), { userId: 1, skillSecret: 'x' }); }
  catch { threw = true; }
  check(threw, 'throws on non-string userId');

  threw = false;
  try { pair.store(123, { userId: 'u', skillSecret: 'x' }); }
  catch { threw = true; }
  check(threw, 'throws on non-string code');
});

test('expired entry returns null and is dropped', () => {
  pair.store('EXPIRED123', { userId: 'u1', skillSecret: 'aa'.repeat(32) }, -1);
  // ttl = -1 → expiresAt is in the past
  eq(pair.take('EXPIRED123'), null, 'take returns null for expired');
});

test('sweep removes expired entries', () => {
  pair.store('LIVE234567', { userId: 'u1', skillSecret: 'aa'.repeat(32) }, 60000);
  pair.store('DEAD234567', { userId: 'u2', skillSecret: 'bb'.repeat(32) }, -1);
  pair.store('GHOST23456', { userId: 'u3', skillSecret: 'cc'.repeat(32) }, -1);
  const removed = pair.sweep();
  eq(removed, 2, 'two expired removed');
  eq(pair.size(), 1, 'one live entry left');
  eq(pair.take('LIVE234567')?.userId, 'u1', 'live entry intact');
});

test('multiple codes for same userId are independent', () => {
  pair.store('CODE111111', { userId: 'u1', skillSecret: 'aa'.repeat(32) });
  pair.store('CODE222222', { userId: 'u1', skillSecret: 'aa'.repeat(32) });
  eq(pair.size(), 2, 'two entries stored');
  pair.take('CODE111111');
  eq(pair.size(), 1, 'taking one leaves the other');
  eq(pair.take('CODE222222')?.userId, 'u1', 'sibling still readable');
});

// Cleanup any lingering timers so the test process exits.
pair._resetForTests();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
