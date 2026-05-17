#!/usr/bin/env node
// Unit tests for MiniserverStateCache. Pure JS, no network.
'use strict';

const { MiniserverStateCache } = require('../src/state-cache');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }
function eq(a, b, label) { check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function test(name, fn) { console.log(`# ${name}`); try { fn(); } catch (e) { nope('threw', e.stack || e.message); } console.log(''); }

test('ingests value events; later events overwrite earlier ones', () => {
  let t = 1000;
  const cache = new MiniserverStateCache({ now: () => t });
  cache.ingest({ kind: 'value', events: [{ uuid: 'u1', value: 1 }, { uuid: 'u2', value: 2 }] });
  eq(cache.eventsSeen, 2, 'eventsSeen after first batch');
  eq(cache.getValue('u1').value, 1, 'u1 stored');
  eq(cache.getValue('u1').updatedAt, 1000, 'u1 updatedAt');

  t = 2000;
  cache.ingest({ kind: 'value', events: [{ uuid: 'u1', value: 1.5 }] });
  eq(cache.eventsSeen, 3, 'eventsSeen accumulates');
  eq(cache.getValue('u1').value, 1.5, 'u1 overwritten');
  eq(cache.getValue('u1').updatedAt, 2000, 'u1 updatedAt advanced');
});

test('ingests text events into separate map', () => {
  let t = 100;
  const cache = new MiniserverStateCache({ now: () => t });
  cache.ingest({ kind: 'text', events: [{ uuid: 'u1', text: 'hello' }] });
  cache.ingest({ kind: 'value', events: [{ uuid: 'u1', value: 7 }] });
  eq(cache.getText('u1').text, 'hello', 'text stored');
  eq(cache.getValue('u1').value, 7, 'value stored under same uuid');
  eq(cache.eventsSeen, 2, 'both counted');
});

test('daytimer + weather counted but not stored', () => {
  const cache = new MiniserverStateCache();
  cache.ingest({ kind: 'daytimer', events: [{ uuid: 'a' }, { uuid: 'b' }] });
  cache.ingest({ kind: 'weather',  events: [{ uuid: 'c' }] });
  eq(cache.values.size, 0, 'no values stored');
  eq(cache.texts.size, 0, 'no texts stored');
  eq(cache.eventsSeen, 3, 'count includes daytimer + weather');
});

test('unknown kind ignored cleanly', () => {
  const cache = new MiniserverStateCache();
  const applied = cache.ingest({ kind: 'unknown', identifier: 99 });
  eq(applied, 0, 'returns 0');
  eq(cache.eventsSeen, 0, 'eventsSeen unchanged');
});

test('snapshotSummary contains the right fields', () => {
  let t = 12345;
  const cache = new MiniserverStateCache({ now: () => t });
  cache.ingest({ kind: 'value', events: [{ uuid: 'a', value: 1 }, { uuid: 'b', value: 2 }] });
  cache.ingest({ kind: 'text',  events: [{ uuid: 'c', text: 'x' }] });
  const s = cache.snapshotSummary();
  eq(s.eventsSeen, 3, 'eventsSeen');
  eq(s.valueCount, 2, 'valueCount');
  eq(s.textCount, 1, 'textCount');
  eq(typeof s.lastEventAt, 'string', 'lastEventAt is ISO string');
  check(s.lastEventAt.endsWith('Z'), 'lastEventAt is UTC');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
