#!/usr/bin/env node
// Unit tests for LoxoneCommandClient — no Perl, no Miniserver needed.
// Spawns the Node-based mock to exercise every result category.
//
// Run from bin/:  node test/test-loxone-command.cjs
'use strict';

const path = require('node:path');
const { LoxoneCommandClient } = require('../src/loxone-command');

// Tiny captured-log shim so we can assert what the wrapper logged.
function makeLog() {
  const calls = [];
  function record(level) {
    return (objOrMsg, maybeMsg) => calls.push({ level, ...(typeof objOrMsg === 'object' ? objOrMsg : { msg: objOrMsg }), msg: maybeMsg ?? (typeof objOrMsg === 'string' ? objOrMsg : undefined) });
  }
  const api = {
    debug: record('debug'),
    info:  record('info'),
    warn:  record('warn'),
    error: record('error'),
    child() { return api; },
    _calls: calls,
  };
  return api;
}

let pass = 0;
let fail = 0;

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

async function test(name, fn) {
  console.log(`# ${name}`);
  try {
    await fn();
  } catch (err) {
    console.log(`  ✗ threw: ${err.message}`);
    fail++;
  }
  console.log('');
}

const SCRIPT = path.join(__dirname, 'mock-lox-send.cjs');

function newClient(overrides = {}) {
  return new LoxoneCommandClient({
    scriptPath: SCRIPT,
    executable: 'node',
    timeoutMs: 1500,
    log: makeLog(),
    ...overrides,
  });
}

(async () => {
  await test('success path: "ok" → exit 0, category=success', async () => {
    const r = await newClient().send({ msNo: 1, name: 'PluginTest', value: 'hello' });
    assertEqual(r.ok, true, 'ok');
    assertEqual(r.exitCode, 0, 'exitCode');
    assertEqual(r.category, 'success', 'category');
    assertEqual(r.stdout, 'ok', 'stdout');
    assertEqual(r.stderr, '', 'stderr');
    assertEqual(r.spawnError, null, 'spawnError');
    assertEqual(typeof r.durationMs, 'number', 'durationMs is number');
  });

  await test('miniserver fail: "fail" → exit 1, category=exit_nonzero', async () => {
    const r = await newClient().send({ msNo: 1, name: 'fail', value: 'x' });
    assertEqual(r.ok, false, 'ok=false');
    assertEqual(r.exitCode, 1, 'exitCode');
    assertEqual(r.category, 'exit_nonzero', 'category');
    assertEqual(r.stdout, 'fail: simulated miniserver failure', 'stdout');
  });

  await test('timeout: "hang" + tight timeout → killed, category=timeout', async () => {
    const client = newClient({ timeoutMs: 300 });
    const r = await client.send({ msNo: 1, name: 'hang', value: 'x' });
    assertEqual(r.ok, false, 'ok=false');
    assertEqual(r.exitCode, null, 'exitCode null');
    assertEqual(r.category, 'timeout', 'category');
  });

  await test('spawn failure: nonexistent executable → category=spawn_failed', async () => {
    const client = newClient({ executable: 'this-binary-does-not-exist-anywhere' });
    const r = await client.send({ msNo: 1, name: 'PluginTest', value: 'x' });
    assertEqual(r.ok, false, 'ok=false');
    assertEqual(r.category, 'spawn_failed', 'category');
    assertEqual(r.spawnError, 'ENOENT', 'spawnError=ENOENT');
  });

  await test('stderr captured on failure path (warn-level log)', async () => {
    const log = makeLog();
    const client = newClient({ log });
    const r = await client.send({ msNo: 1, name: 'noisy-stderr-fail', value: 'x' });
    assertEqual(r.ok, false, 'ok=false');
    assertEqual(r.stderr, 'simulated diagnostic from helper', 'stderr captured');
    const warns = log._calls.filter((c) => c.level === 'warn');
    assertEqual(warns.length, 1, 'one warn log');
  });

  await test('stderr captured on success path (debug-level log)', async () => {
    const log = makeLog();
    const client = newClient({ log });
    const r = await client.send({ msNo: 1, name: 'noisy-stderr-ok', value: 'x' });
    assertEqual(r.ok, true, 'ok=true');
    assertEqual(r.stderr, 'simulated chatter', 'stderr captured');
    const debugs = log._calls.filter((c) => c.level === 'debug');
    assertEqual(debugs.length, 1, 'one debug log');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
