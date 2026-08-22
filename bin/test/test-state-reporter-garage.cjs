#!/usr/bin/env node
// Unit tests for the proactive ChangeReport path of a Gate exposed as a
// GARAGE_DOOR.
//
// One Loxone control type backs two Alexa renderings, and they report the
// SAME state UUID (`position`) under different capabilities: RangeController
// for the DOOR arm, ModeController(GarageDoor.Position) for the garage arm.
// The mapper therefore branches on the device row (category + capability), not
// on the control type, and must reach the same verdict as the pull path's
// DirectiveRouter._isGarageEndpoint.
//
// The failure this pins down is quiet rather than loud: emit the
// RangeController property for a garage door and the downstream capability
// filter drops it, so the door never sends a proactive update at all. Its
// tile just sits at whatever Alexa last saw. Nothing logs an error.
'use strict';

const { StateReporter }        = require('../src/state-reporter');
const { MiniserverStateCache } = require('../src/state-cache');

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

const nullLog = {
  child() { return nullLog; },
  debug() {}, info() {}, warn() {}, error() {},
};

const GATE_CONTROL = { type: 'Gate', states: { position: 'S-gate' } };

// Same Loxone Gate every time; only the device row's category + capability
// differ, which is exactly the pair the picker flips when the user selects
// GARAGE_DOOR.
function harness(device) {
  const sent = [];
  const stateCache = new MiniserverStateCache();
  const reporter = new StateReporter({
    structure:     { getControl: (uuid) => (uuid === 'dev-gate' ? GATE_CONTROL : null) },
    devicesConfig: { list: () => [device], on() {}, off() {} },
    stateCache,
    bridgeClient:  { sendReport: (m) => { sent.push(m); return true; } },
    identity:      { userId: 'test-user', skillSecretBytes: Buffer.alloc(32, 7) },
    log:           nullLog,
  });
  reporter.start();
  const changed = () => sent.map(
    (m) => JSON.parse(m.payload).changeReport.event.payload.change.properties,
  );
  return { reporter, stateCache, sent, changed };
}

function garageHarness() {
  return harness({
    uuid: 'dev-gate', enabled: true,
    displayCategory: 'GARAGE_DOOR', capabilities: ['ModeController'],
    // A leftover from the device's DOOR days. The garage path must ignore it:
    // mirroring the axis here would report a closing door as opening.
    rangeAxisInverted: true,
  });
}

// The cache emits `change` only on a transition, never on first insertion.
function push(stateCache, uuid, value) {
  stateCache.ingest({ kind: 'value', events: [{ uuid, value }] });
}

(async () => {

await test('opening reports ModeController, not RangeController', async () => {
  const h = garageHarness();
  push(h.stateCache, 'S-gate', 0);      // priming insert, closed
  push(h.stateCache, 'S-gate', 1);      // fully open
  eq(h.sent.length, 1, 'one report dispatched');
  const props = h.changed()[0];
  eq(props.length, 1, 'exactly one property');
  eq(props[0].namespace, 'Alexa.ModeController', 'reported as a mode');
  eq(props[0].instance, 'GarageDoor.Position', 'under the instance Discovery advertised');
  eq(props[0].value, 'Position.Up', 'open');
  h.reporter.stop();
});

await test('closing reports Position.Down', async () => {
  const h = garageHarness();
  push(h.stateCache, 'S-gate', 1);
  push(h.stateCache, 'S-gate', 0);
  eq(h.sent.length, 1, 'one report dispatched');
  eq(h.changed()[0][0].value, 'Position.Down', 'closed');
  h.reporter.stop();
});

await test('a partially open gate reports Open, never Closed', async () => {
  // Alexa's Closed state drives routines like "if the garage door is closed,
  // arm the alarm". A gate stopped at 30% must not satisfy that.
  const h = garageHarness();
  push(h.stateCache, 'S-gate', 0);
  push(h.stateCache, 'S-gate', 0.3);
  eq(h.changed()[0][0].value, 'Position.Up', 'partially open counts as open');
  h.reporter.stop();
});

await test('a gate crossing intermediate positions reports one transition, then stays put', async () => {
  // Loxone streams `position` continuously while the motor runs. The mode is
  // two-valued, so every step after the first collapses to the same value and
  // must be suppressed as a duplicate rather than spamming Alexa with a
  // report per centimetre of travel.
  const h = garageHarness();
  push(h.stateCache, 'S-gate', 0);
  push(h.stateCache, 'S-gate', 0.1);
  eq(h.sent.length, 1, 'the first move off the closed stop reports');
  push(h.stateCache, 'S-gate', 0.4);
  push(h.stateCache, 'S-gate', 0.8);
  push(h.stateCache, 'S-gate', 1);
  eq(h.sent.length, 1, 'the rest of the travel is suppressed as duplicates');
  h.reporter.stop();
});

await test('the DOOR arm of the same control still reports RangeController', async () => {
  // Regression guard: the branch keys off the device row, not the control
  // type, so a plain Gate must be completely unaffected by the garage work.
  const h = harness({
    uuid: 'dev-gate', enabled: true,
    displayCategory: 'DOOR', capabilities: ['RangeController'],
    rangeAxisInverted: false,
  });
  push(h.stateCache, 'S-gate', 0);
  push(h.stateCache, 'S-gate', 0.5);
  const props = h.changed()[0];
  eq(props[0].namespace, 'Alexa.RangeController', 'still a range');
  eq(props[0].value, 50, '0.5 -> 50%');
  h.reporter.stop();
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

})();
