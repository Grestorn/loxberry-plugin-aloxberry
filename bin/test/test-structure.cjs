#!/usr/bin/env node
// Unit tests for StructureCache._parse — parser correctness.
// (The Perl-helper-spawning fetch path is exercised live on the LoxBerry,
// not in unit tests, because it talks to a real Miniserver.)
'use strict';

const { StructureCache, alexaInfoForType } = require('../src/structure');

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

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
function newCache() { return new StructureCache({ dataDir: require('os').tmpdir(), log: noopLog }); }

// A minimal slice of LoxAPP3.json with one room, one category, one parent
// control, and one subControl. Covers the common shapes the picker faces.
const SAMPLE = {
  lastModified: '2026-05-01 10:00:00',
  msInfo: { msName: 'Test MS', serialNr: '504F94' },
  rooms: {
    'room-1': { name: 'Wohnzimmer', type: 0 },
    'room-2': { name: 'Küche',      type: 0 },
  },
  cats: {
    'cat-light': { name: 'Beleuchtung', type: 'lights' },
  },
  controls: {
    'ctrl-switch': {
      name: 'Schalter Steckdose',
      type: 'Switch',
      uuidAction: 'ctrl-switch',
      room: 'room-2',
      cat: 'cat-light',
    },
    'ctrl-lcv2': {
      name: 'Decke',
      type: 'LightControllerV2',
      uuidAction: 'ctrl-lcv2',
      room: 'room-1',
      cat: 'cat-light',
      subControls: {
        'sub-mood-1': {
          name: 'Filmabend',
          type: 'Mood',
        },
        'sub-switch-1': {
          name: 'Couch',
          type: 'Switch',
          uuidAction: 'sub-switch-1',
        },
      },
    },
    'ctrl-unknown': {
      name: 'Mystery',
      type: 'WeirdLoxoneType',
      room: 'room-1',
    },
    'ctrl-radio': {
      name: 'Diavolo Status',
      type: 'Radio',
      uuidAction: 'ctrl-radio',
      room: 'room-1',
      // The `details` block the Radio resolver depends on. Regression
      // guard: if _parse stops copying `details`, this disappears and the
      // assertion below fails (the real-world symptom was a Radio that
      // resolved zero outputs → zero capabilities → Alexa dropped it).
      details: {
        allOff: 'Alles aus',
        outputs: { 1: 'Online / Wakeup', 2: 'Sleep', 6: 'Force Shutdown' },
      },
      states: { activeOutput: 'st-radio-active' },
    },
  },
};

test('parses rooms + cats into flat lists', () => {
  const c = newCache();
  const parsed = c._parse(SAMPLE);
  eq(parsed.rooms.length, 2, 'two rooms');
  eq(parsed.rooms.find(r => r.uuid === 'room-1').name, 'Wohnzimmer', 'room-1 name');
  eq(parsed.cats.length, 1, 'one cat');
  eq(parsed.cats[0].name, 'Beleuchtung', 'cat name');
  eq(parsed.msName, 'Test MS', 'msInfo.msName extracted');
});

test('flattens controls and subControls', () => {
  const c = newCache();
  const parsed = c._parse(SAMPLE);
  // 4 top-level (switch, lcv2, unknown, radio) + 2 subControls = 6 entries
  eq(parsed.controls.length, 6, '6 controls total');
});

test('_parse copies the raw details block (Radio outputs etc.)', () => {
  // Regression guard for the "Diavolo Status doesn't appear in Alexa" bug:
  // the parser used to drop `details`, so Radio/Ventilation/Sequential
  // resolvers got undefined and produced zero capabilities → Alexa
  // rejected the endpoint outright.
  const c = newCache();
  const parsed = c._parse(SAMPLE);
  const radio = parsed.controls.find(x => x.uuid === 'ctrl-radio');
  check(!!radio, 'radio control found');
  check(!!radio.details, 'details present on parsed control');
  eq(radio.details.outputs['1'], 'Online / Wakeup', 'outputs map preserved');
  eq(radio.details.allOff, 'Alles aus', 'allOff preserved');
  // Controls without a details block parse to null, not a crash.
  const sw = parsed.controls.find(x => x.uuid === 'ctrl-switch');
  eq(sw.details, null, 'detail-less control → null (no throw)');
});

test('subControls have parent reference + inherit room/cat when missing', () => {
  const c = newCache();
  const parsed = c._parse(SAMPLE);
  const couch = parsed.controls.find(x => x.uuid === 'sub-switch-1');
  check(!!couch, 'sub-switch-1 found');
  eq(couch.parentUuid, 'ctrl-lcv2', 'parentUuid');
  eq(couch.parentName, 'Decke', 'parentName');
  eq(couch.roomName, 'Wohnzimmer', 'inherited room from parent');
});

test('alexaCompatible flag set per type', () => {
  const c = newCache();
  const parsed = c._parse(SAMPLE);
  const sw   = parsed.controls.find(x => x.uuid === 'ctrl-switch');
  const lcv2 = parsed.controls.find(x => x.uuid === 'ctrl-lcv2');
  const unk  = parsed.controls.find(x => x.uuid === 'ctrl-unknown');
  eq(sw.alexaCompatible,   true,  'Switch is compatible');
  eq(lcv2.alexaCompatible, true,  'LightControllerV2 is compatible');
  eq(unk.alexaCompatible,  false, 'WeirdLoxoneType is NOT compatible');
});

test('compatible controls expose defaults; incompatible ones do not', () => {
  const c = newCache();
  const parsed = c._parse(SAMPLE);
  const sw = parsed.controls.find(x => x.uuid === 'ctrl-switch');
  eq(sw.defaults.displayCategory, 'SWITCH', 'Switch → SWITCH');
  eq(sw.defaults.capabilities[0], 'PowerController', 'Switch → PowerController');
  const unk = parsed.controls.find(x => x.uuid === 'ctrl-unknown');
  eq(unk.defaults, null, 'unknown type has no defaults');
});

test('v1Implemented marks the daemon-supported subset', () => {
  const c = newCache();
  const parsed = c._parse(SAMPLE);
  eq(parsed.controls.find(x => x.uuid === 'ctrl-switch').v1Implemented, true,  'Switch v1 implemented');
  eq(parsed.controls.find(x => x.uuid === 'ctrl-lcv2').v1Implemented,  true,  'LightControllerV2 v1 implemented');
  // Mood is in TYPE_MAP-incompatible (not in our list) → v1Implemented=false
  eq(parsed.controls.find(x => x.uuid === 'sub-mood-1').v1Implemented, false, 'Mood subControl not v1 implemented');
});

test('alexaInfoForType is exported and queryable', () => {
  eq(alexaInfoForType('Switch').category, 'SWITCH', 'Switch maps to SWITCH');
  eq(alexaInfoForType('Dimmer').capabilities.length, 2, 'Dimmer has 2 capabilities');
  eq(alexaInfoForType('NoSuchType'), null, 'unknown type returns null');
});

test('getControl resolves by uuid', () => {
  const c = newCache();
  c.parsed = c._parse(SAMPLE);
  eq(c.getControl('ctrl-switch')?.name, 'Schalter Steckdose', 'found by uuid');
  eq(c.getControl('does-not-exist'), null, 'unknown uuid → null');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
