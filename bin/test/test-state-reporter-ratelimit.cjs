#!/usr/bin/env node
// Unit tests for StateReporter's proactive-report rate control:
// duplicate suppression + the analog-sensor minimum-interval floor.
// Pure JS, no network. Drives the real MiniserverStateCache so the
// cache -> reverse-index -> mapping -> rate-control path is exercised
// end to end; only the bridge transport is stubbed.
'use strict';

// Must be set before requiring state-reporter: SENSOR_MIN_INTERVAL_MS is
// resolved once at module load. 80ms keeps the suite fast while still
// exercising the real setTimeout path rather than a mocked clock.
const INTERVAL_MS = 80;
process.env.ALOXBERRY_SENSOR_MIN_INTERVAL_MS = String(INTERVAL_MS);

const { StateReporter }         = require('../src/state-reporter');
const { MiniserverStateCache }  = require('../src/state-cache');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const nullLog = {
  child() { return nullLog; },
  debug() {}, info() {}, warn() {}, error() {},
};

// Builds a reporter wired to a real state cache. `sent` collects the
// ChangeReports that reached the (stubbed) bridge.
function harness({ controls, devices }) {
  const sent = [];
  const stateCache = new MiniserverStateCache();
  const deviceList = devices;

  const reporter = new StateReporter({
    structure:     { getControl: (uuid) => controls[uuid] || null },
    devicesConfig: { list: () => deviceList, on() {}, off() {} },
    stateCache,
    bridgeClient:  { sendReport: (m) => { sent.push(m); return true; } },
    identity:      { userId: 'test-user', skillSecretBytes: Buffer.alloc(32, 7) },
    log:           nullLog,
  });
  reporter.start();

  // Unwrap the signed envelope back to the properties Alexa would receive.
  const changed = () => sent.map(
    (m) => JSON.parse(m.payload).changeReport.event.payload.change.properties,
  );
  return { reporter, stateCache, sent, changed, deviceList };
}

const TEMP_CONTROL = {
  type: 'InfoOnlyAnalog',
  states: { value: 'S-temp' },
  details: { format: '%.1f°C' },
};
const SWITCH_CONTROL = {
  type: 'Switch',
  states: { active: 'S-switch' },
};

function tempSetup() {
  return harness({
    controls: { 'dev-temp': TEMP_CONTROL },
    // Only TemperatureSensor: InfoOnlyAnalog emits temperature AND humidity,
    // and the capability filter drops the one the device didn't declare.
    devices: [{ uuid: 'dev-temp', enabled: true, capabilities: ['TemperatureSensor'] }],
  });
}

// The cache emits `change` only on a transition, never on first insertion,
// so every test primes the UUID before driving real changes through it.
function push(stateCache, uuid, value) {
  stateCache.ingest({ kind: 'value', events: [{ uuid, value }] });
}

// ---------------------------------------------------------------------------

(async () => {

await test('temperature is quantised to 0.1 C', async () => {
  const h = tempSetup();
  push(h.stateCache, 'S-temp', 20.0);      // priming insert, no change event
  push(h.stateCache, 'S-temp', 21.3421);   // transition -> report
  eq(h.sent.length, 1, 'one report dispatched');
  const props = h.changed()[0];
  const temp = props.find((p) => p.namespace === 'Alexa.TemperatureSensor');
  eq(temp.value.value, 21.3, 'value quantised to one decimal');
  h.reporter.stop();
});

await test('a raw change that quantises to the same value is suppressed', async () => {
  const h = tempSetup();
  push(h.stateCache, 'S-temp', 20.0);
  push(h.stateCache, 'S-temp', 21.3421);
  eq(h.sent.length, 1, 'first reading reported');
  // Different raw float, same value Alexa would receive -> carries no
  // information. Checked before the interval floor, so timing is irrelevant.
  push(h.stateCache, 'S-temp', 21.3438);
  eq(h.sent.length, 1, 'duplicate not reported');
  eq(h.reporter._cacheStats.duplicate, 1, 'counted as duplicate');
  h.reporter.stop();
});

await test('SAFETY: a change inside the window is deferred, never dropped', async () => {
  const h = tempSetup();
  push(h.stateCache, 'S-temp', 20.0);
  push(h.stateCache, 'S-temp', 21.0);
  eq(h.sent.length, 1, 'first reading reported immediately');

  // Genuinely different reading, arriving while the window is closed.
  push(h.stateCache, 'S-temp', 25.0);
  eq(h.sent.length, 1, 'held back rather than sent immediately');
  eq(h.reporter._cacheStats.deferred, 1, 'counted as deferred');

  // This is the property that makes the throttle safe: if this were a
  // plain drop, Alexa would show 21.0 forever once the sensor went quiet.
  await sleep(INTERVAL_MS * 2);
  eq(h.sent.length, 2, 'deferred reading delivered after the window closed');
  const temp = h.changed()[1].find((p) => p.namespace === 'Alexa.TemperatureSensor');
  eq(temp.value.value, 25.0, 'the held value reached Alexa');
  h.reporter.stop();
});

await test('newest value wins while deferred; window is not extended', async () => {
  const h = tempSetup();
  push(h.stateCache, 'S-temp', 20.0);
  push(h.stateCache, 'S-temp', 21.0);
  eq(h.sent.length, 1, 'first reading reported');

  push(h.stateCache, 'S-temp', 22.0);
  push(h.stateCache, 'S-temp', 23.0);
  push(h.stateCache, 'S-temp', 24.0);
  eq(h.sent.length, 1, 'all three coalesced into the pending slot');

  await sleep(INTERVAL_MS * 2);
  eq(h.sent.length, 2, 'exactly one flush for the whole burst');
  const temp = h.changed()[1].find((p) => p.namespace === 'Alexa.TemperatureSensor');
  eq(temp.value.value, 24.0, 'newest value shipped, intermediates discarded');
  h.reporter.stop();
});

await test('SAFETY: discrete properties are never deferred', async () => {
  const h = harness({
    controls: { 'dev-sw': SWITCH_CONTROL },
    devices: [{ uuid: 'dev-sw', enabled: true, capabilities: ['PowerController'] }],
  });
  push(h.stateCache, 'S-switch', 0);   // priming insert
  push(h.stateCache, 'S-switch', 1);   // ON
  push(h.stateCache, 'S-switch', 0);   // OFF
  push(h.stateCache, 'S-switch', 1);   // ON
  // A deferred powerState would make a wall switch look broken, so the
  // interval floor must not apply however fast these arrive.
  eq(h.sent.length, 3, 'every transition reported immediately');
  eq(h.reporter._cacheStats.deferred, 0, 'nothing deferred');
  const states = h.changed().map((ps) => ps.find((p) => p.name === 'powerState').value);
  eq(states.join(','), 'ON,OFF,ON', 'states delivered in order');
  h.reporter.stop();
});

await test('stop() cancels pending flushes', async () => {
  const h = tempSetup();
  push(h.stateCache, 'S-temp', 20.0);
  push(h.stateCache, 'S-temp', 21.0);
  push(h.stateCache, 'S-temp', 25.0);   // deferred
  eq(h.reporter._pending.size, 1, 'one flush pending');

  h.reporter.stop();
  eq(h.reporter._pending.size, 0, 'pending cleared by stop()');
  await sleep(INTERVAL_MS * 2);
  eq(h.sent.length, 1, 'no dispatch after stop()');
});

await test('a device disabled while deferred is not reported', async () => {
  const h = tempSetup();
  push(h.stateCache, 'S-temp', 20.0);
  push(h.stateCache, 'S-temp', 21.0);
  push(h.stateCache, 'S-temp', 25.0);   // deferred
  eq(h.sent.length, 1, 'only the first reading so far');

  // Simulate devices.json turning the device off during the window.
  h.deviceList[0].enabled = false;
  await sleep(INTERVAL_MS * 2);
  eq(h.sent.length, 1, 'no report for an endpoint Alexa no longer has');
  h.reporter.stop();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

})();
