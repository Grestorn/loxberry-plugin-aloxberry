#!/usr/bin/env node
// Unit tests for bridge/src/routing.js — anti-hijack displacement logic (P0 #5).
'use strict';

const routing = require('../src/routing');

let pass = 0, fail = 0;
function ok(l)        { console.log(`  ✓ ${l}`); pass++; }
function nope(l, d)   { console.log(`  ✗ ${l}${d ? ': ' + d : ''}`); fail++; }
function eq(a, b, l)  { (a === b ? ok : nope)(l, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function test(n, fn)  { console.log(`# ${n}`); routing._resetForTests(); try { fn(); } catch (e) { nope('threw', e.stack); } console.log(''); }

const OPEN = 1, CLOSED = 3;
const mkWs = (rs = OPEN) => ({ readyState: rs, OPEN });

test('empty slot → added', () => {
  const a = mkWs();
  eq(routing.tryAdd('u', a, 1000).action, 'added', 'added');
  eq(routing.get('u'), a, 'get returns the ws (unwrapped, back-compat)');
});

test('live + fresh prior socket → newcomer REJECTED, original kept', () => {
  const live = mkWs();
  routing.tryAdd('u', live, 1000);
  const attacker = mkWs();
  const d = routing.tryAdd('u', attacker, 1000 + 5000); // 5s later, < STALE_MS
  eq(d.action, 'rejected', 'attacker rejected');
  eq(routing.get('u'), live, 'legit socket still owns the slot');
});

test('prior socket not OPEN → displaced', () => {
  const dead = mkWs(CLOSED);
  routing.tryAdd('u', dead, 1000);
  const fresh = mkWs();
  const d = routing.tryAdd('u', fresh, 1000 + 1000);
  eq(d.action, 'displaced', 'displaced');
  eq(d.old, dead, 'old ws returned for close');
  eq(routing.get('u'), fresh, 'new socket owns the slot');
});

test('prior socket OPEN but stale (no traffic past STALE_MS) → displaced', () => {
  const stale = mkWs();
  routing.tryAdd('u', stale, 1000);
  const d = routing.tryAdd('u', mkWs(), 1000 + routing.STALE_MS + 1);
  eq(d.action, 'displaced', 'stale live socket can be displaced (legit reconnect)');
});

test('touch keeps a socket fresh and blocks takeover', () => {
  const live = mkWs();
  routing.tryAdd('u', live, 1000);
  // Just before going stale, real traffic arrives → liveness refreshed.
  routing.touch('u', live, 1000 + routing.STALE_MS - 1);
  const d = routing.tryAdd('u', mkWs(), 1000 + routing.STALE_MS + 1);
  eq(d.action, 'rejected', 'refreshed socket still protected');
});

test('touch from a non-owning ws is ignored', () => {
  const live = mkWs();
  routing.tryAdd('u', live, 1000);
  routing.touch('u', mkWs(), 1000 + 10); // different ws
  // Original lastSeenAt unchanged → becomes displaceable on schedule.
  const d = routing.tryAdd('u', mkWs(), 1000 + routing.STALE_MS + 1);
  eq(d.action, 'displaced', 'foreign touch did not extend liveness');
});

test('remove only removes the owning ws', () => {
  const a = mkWs(); const b = mkWs();
  routing.tryAdd('u', a, 1000);
  eq(routing.remove('u', b), false, 'non-owner remove is a no-op');
  eq(routing.get('u'), a, 'still mapped');
  eq(routing.remove('u', a), true, 'owner remove succeeds');
  eq(routing.has('u'), false, 'gone');
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
