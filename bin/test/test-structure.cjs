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

test('TimedSwitch offers SceneController as an exclusive alternative to Power', () => {
  const info = alexaInfoForType('TimedSwitch');
  eq(info.capabilities[0], 'PowerController', 'primary cap is PowerController');
  check(info.optionalCapabilities.indexOf('SceneController') >= 0,
    'SceneController offered as optional');
  // Exclusive group means the picker enforces "exactly one of the two".
  check(info.exclusiveCapabilities.indexOf('PowerController') >= 0
        && info.exclusiveCapabilities.indexOf('SceneController') >= 0,
    'Power/Scene are mutually exclusive');
  // Scene-style categories must be selectable so it renders as a Scene.
  check(info.allowedCategories.indexOf('SCENE_TRIGGER') >= 0,
    'SCENE_TRIGGER allowed');
  check(info.allowedCategories.indexOf('ACTIVITY_TRIGGER') >= 0,
    'ACTIVITY_TRIGGER allowed');
  // Picker coupling map: each capability lists its categories; OTHER shared.
  const cc = info.capabilityCategories;
  check(!!cc, 'declares capabilityCategories');
  check(cc.SceneController.indexOf('SCENE_TRIGGER') >= 0,
    'SceneController → SCENE_TRIGGER');
  check(cc.PowerController.indexOf('SWITCH') >= 0,
    'PowerController → SWITCH');
  check(cc.PowerController.indexOf('SCENE_TRIGGER') < 0,
    'PowerController does NOT list SCENE_TRIGGER (no nonsensical pair)');
  check(cc.PowerController.indexOf('OTHER') >= 0 && cc.SceneController.indexOf('OTHER') >= 0,
    'OTHER is shared by both (never force-flips)');
});

test('Gate couples GARAGE_DOOR to the voice-code-gated ModeController arm', () => {
  const info = alexaInfoForType('Gate');
  eq(info.capabilities[0], 'RangeController', 'default arm stays RangeController');
  eq(info.category, 'DOOR', 'default category stays DOOR (garage door is opt-in)');
  check(info.optionalCapabilities.indexOf('ModeController') >= 0,
    'ModeController offered as the opt-in alternative');
  check(info.exclusiveCapabilities.indexOf('RangeController') >= 0
        && info.exclusiveCapabilities.indexOf('ModeController') >= 0,
    'the two renderings are mutually exclusive');
  check(info.allowedCategories.indexOf('GARAGE_DOOR') >= 0, 'GARAGE_DOOR selectable');
  const cc = info.capabilityCategories;
  check(!!cc, 'declares capabilityCategories');
  check(cc.ModeController.indexOf('GARAGE_DOOR') >= 0,
    'ModeController → GARAGE_DOOR');
  check(cc.RangeController.indexOf('GARAGE_DOOR') < 0,
    'RangeController does NOT list GARAGE_DOOR (a garage door is never a range)');
  // Unlike every other coupled type, OTHER is deliberately NOT shared into the
  // ModeController arm: a GarageDoor.Position ModeController on an OTHER tile
  // is the near-miss shape Alexa accepts but never voice-code gates, so
  // picking GARAGE_DOOR must always force-flip the capability.
  check(cc.ModeController.indexOf('OTHER') < 0,
    'OTHER is not shared into the garage arm (GARAGE_DOOR always force-flips)');
  eq(cc.ModeController.length, 1, 'GARAGE_DOOR is the sole garage-arm category');
  // Union of the arms must equal allowedCategories, as for every other type.
  const union = cc.RangeController.concat(cc.ModeController).sort().join(',');
  eq(union, info.allowedCategories.slice().sort().join(','),
    'arm categories union to allowedCategories');
});

test('InfoOnlyAnalog couples both sensor arms to their categories', () => {
  const cc = alexaInfoForType('InfoOnlyAnalog').capabilityCategories;
  check(!!cc, 'declares capabilityCategories');
  check(cc.TemperatureSensor.indexOf('TEMPERATURE_SENSOR') >= 0, 'Temp → TEMPERATURE_SENSOR');
  check(cc.HumiditySensor.indexOf('HUMIDITY_SENSOR') >= 0, 'Humidity → HUMIDITY_SENSOR');
  check(cc.TemperatureSensor.indexOf('HUMIDITY_SENSOR') < 0, 'Temp does NOT list HUMIDITY_SENSOR');
  check(cc.TemperatureSensor.indexOf('OTHER') >= 0 && cc.HumiditySensor.indexOf('OTHER') >= 0,
    'OTHER shared (never force-flips)');
});

test('InfoOnlyDigital couples sensor arms but leaves ModeController uncoupled', () => {
  const cc = alexaInfoForType('InfoOnlyDigital').capabilityCategories;
  check(!!cc, 'declares capabilityCategories');
  check(cc.ContactSensor.indexOf('CONTACT_SENSOR') >= 0, 'Contact → CONTACT_SENSOR');
  check(cc.MotionSensor.indexOf('MOTION_SENSOR') >= 0, 'Motion → MOTION_SENSOR');
  // The custom-label ModeController arm is deliberately NOT in the map.
  eq(cc.ModeController, undefined, 'ModeController arm is uncoupled');
  // OTHER must be in BOTH mapped arms so selecting it (the ModeController-
  // friendly category) never force-flips away from a sensor or ModeController.
  check(cc.ContactSensor.indexOf('OTHER') >= 0 && cc.MotionSensor.indexOf('OTHER') >= 0,
    'OTHER shared by both sensor arms (matches 2 → never force-flips)');
});

test('getControl resolves by uuid', () => {
  const c = newCache();
  c.parsed = c._parse(SAMPLE);
  eq(c.getControl('ctrl-switch')?.name, 'Schalter Steckdose', 'found by uuid');
  eq(c.getControl('does-not-exist'), null, 'unknown uuid → null');
});

// IRoomControllerV2 offers the optional HumiditySensor role ONLY when the
// control actually exposes `humidityActual` (Loxone capabilities bit 14).
// filterOptionalCapabilities() drops it otherwise so the picker never shows
// a checkbox that would always resolve to null.
test('IRoomControllerV2 with humidityActual offers HumiditySensor opt-in', () => {
  const c = newCache();
  const parsed = c._parse({
    rooms: {}, cats: {},
    controls: {
      'irc-humid': {
        name: 'Bad', type: 'IRoomControllerV2', uuidAction: 'irc-humid',
        states: {
          tempActual:    's-actual',
          tempTarget:    's-target',
          operatingMode: 's-mode',
          humidityActual: 's-humid',
        },
      },
    },
  });
  const irc = parsed.controls.find(x => x.uuid === 'irc-humid');
  check(irc.defaults.capabilities.indexOf('HumiditySensor') < 0,
    'HumiditySensor is NOT a default (opt-in only)');
  check(irc.defaults.optionalCapabilities.indexOf('HumiditySensor') >= 0,
    'HumiditySensor offered as optional when humidityActual present');
});

test('IRoomControllerV2 without humidityActual hides HumiditySensor opt-in', () => {
  const c = newCache();
  const parsed = c._parse({
    rooms: {}, cats: {},
    controls: {
      'irc-dry': {
        name: 'Flur', type: 'IRoomControllerV2', uuidAction: 'irc-dry',
        states: {
          tempActual:    's-actual',
          tempTarget:    's-target',
          operatingMode: 's-mode',
        },
      },
    },
  });
  const irc = parsed.controls.find(x => x.uuid === 'irc-dry');
  check(irc.defaults.optionalCapabilities.indexOf('HumiditySensor') < 0,
    'HumiditySensor NOT offered when humidityActual absent');
});

// hasStructure() is the guard that lets callers treat "getControl() === null"
// as proof of deletion rather than as "we never got a structure". Getting it
// wrong would unpublish every device whenever the Miniserver is unreachable.
test('hasStructure distinguishes "no structure" from "control deleted"', () => {
  const c = newCache();
  check(c.hasStructure() === false, 'false before anything is parsed');
  check(c.getControl('ctrl-switch') === null, 'getControl is null before parse');

  c.parsed = c._parse(SAMPLE);
  check(c.hasStructure() === true, 'true once a structure is parsed');
  check(!!c.getControl('ctrl-switch'), 'a live control resolves');
  check(c.getControl('ctrl-deleted-in-loxone') === null, 'a deleted control does not');

  c.parsed = c._parse({ rooms: {}, cats: {}, controls: {} });
  check(c.hasStructure() === false, 'false for a structure with zero controls');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
