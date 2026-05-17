#!/usr/bin/env node
// Unit tests for bin/src/pair-code.js
'use strict';

const pc = require('../src/pair-code');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }
function eq(a, b, label) { check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function test(name, fn) {
  console.log(`# ${name}`);
  try { fn(); } catch (e) { nope('threw', e.stack || e.message); }
  console.log('');
}

test('alphabet is exactly 32 chars', () => {
  eq(pc.ALPHABET.length, 32, '32 chars');
  check(/^[A-Z2-9]+$/.test(pc.ALPHABET), 'all uppercase + digits 2-9');
  // Explicitly excludes ambiguous chars
  check(!pc.ALPHABET.includes('I'), 'no I');
  check(!pc.ALPHABET.includes('O'), 'no O');
  check(!pc.ALPHABET.includes('0'), 'no 0');
  check(!pc.ALPHABET.includes('1'), 'no 1');
});

test('generate() returns 10-char codes from the alphabet', () => {
  for (let i = 0; i < 50; i++) {
    const c = pc.generate();
    eq(c.length, 10, 'length 10');
    for (const ch of c) {
      check(pc.ALPHABET.includes(ch), `char "${ch}" in alphabet`);
    }
  }
});

test('isValid accepts canonical codes, rejects everything else', () => {
  for (let i = 0; i < 10; i++) {
    check(pc.isValid(pc.generate()), 'generated code is valid');
  }
  // Wrong length
  check(!pc.isValid('ABCD'), 'too short');
  check(!pc.isValid('ABCDEFGHJKL'), 'too long');
  // Lowercase rejected (UI is supposed to upper-case before submit)
  check(!pc.isValid('abcdefghjk'), 'lowercase rejected');
  // Forbidden chars
  check(!pc.isValid('ABCDEFGHIJ'), 'contains I');
  check(!pc.isValid('ABCDEFGHJ0'), 'contains 0');
  check(!pc.isValid('ABCDEFGHJ1'), 'contains 1');
  check(!pc.isValid('ABCDEFGHOK'), 'contains O');
  // Wrong type
  check(!pc.isValid(undefined), 'undefined');
  check(!pc.isValid(null), 'null');
  check(!pc.isValid(123), 'number');
});

test('large sample shows good uniformity (no obvious bias)', () => {
  // Not a rigorous test — just catches gross bugs like "every char is the same".
  const N = 500;
  const counts = Object.fromEntries(pc.ALPHABET.split('').map((c) => [c, 0]));
  for (let i = 0; i < N; i++) {
    for (const ch of pc.generate()) counts[ch] += 1;
  }
  const totalChars = N * 10;
  const expected = totalChars / pc.ALPHABET.length;          // ~156
  // Allow up to 50 % deviation per char in 5000 samples — extremely loose.
  for (const [ch, cnt] of Object.entries(counts)) {
    check(Math.abs(cnt - expected) <= expected * 0.5,
      `char "${ch}" count within ±50% of mean`, `got ${cnt}, expected ~${expected}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
