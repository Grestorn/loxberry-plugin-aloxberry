#!/usr/bin/env node
// Unit tests for DirectiveRouter. Mock LoxoneCommandClient — no spawn.
'use strict';

const {
  DirectiveRouter,
  defaultEndpointsForTesting,
  IMPLEMENTED_CAPABILITIES,
  parseSceneList,
} = require('../src/directive-router');

const log = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return this; },
};

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

class MockLoxoneCommand {
  constructor() { this.calls = []; this.nextResult = { ok: true, exitCode: 0, category: 'success', stdout: 'ok', stderr: '', durationMs: 10, spawnError: null }; }
  async send(req)        { this.calls.push({ kind: 'vi',   ...req }); return this.nextResult; }
  async sendByUuid(req)  { this.calls.push({ kind: 'uuid', ...req }); return this.nextResult; }
}

// Mock structure cache with a hand-crafted control list. Each control is a
// plain object — same shape as structure.js produces, but only the fields
// the router reads (type, states, details).
function mockStructure(controls) {
  const byUuid = new Map(controls.map((c) => [c.uuid, c]));
  return { getControl: (u) => byUuid.get(u) || null };
}

// Mock state cache: a flat { uuid: numericValue } map.
function mockStateCache(values) {
  const map = new Map();
  for (const [uuid, v] of Object.entries(values || {})) {
    map.set(uuid, { value: v, updatedAt: new Date().toISOString() });
  }
  return {
    getValue: (u) => map.get(u),
    getText:  () => undefined,
  };
}

// One Jalousie environment: endpoint + structure + (optional) state. Default
// `rangeAxisInverted` matches the per-type default in structure.js (true).
function jalousieEnv({ position = null, axisInverted = true } = {}) {
  const endpoints = [{
    endpointId: 'alexa-jal-uuid',
    friendlyName: 'Bedroom Blind',
    description: 'Bedroom Blind (Loxone Jalousie)',
    displayCategories: ['INTERIOR_BLIND'],
    capabilities: ['RangeController'],
    uuid: 'jal-uuid',
    msNo: 1,
    rangeAxisInverted: axisInverted,
  }];
  const structureCache = mockStructure([{
    uuid: 'jal-uuid', type: 'Jalousie',
    states: { position: 'pos-uuid', up: 'up-uuid', down: 'down-uuid' },
  }]);
  const stateCache = mockStateCache(position != null ? { 'pos-uuid': position } : {});
  return { endpoints, structureCache, stateCache };
}

// Window environment. Loxone position: 0=closed, 1=open (matches Alexa).
// Default axisInverted=false; "moveToPosition/<n>" is the wire format.
function windowEnv({ position = null, axisInverted = false } = {}) {
  const endpoints = [{
    endpointId: 'alexa-win-uuid',
    friendlyName: 'Skylight',
    description: 'Skylight (Loxone Window)',
    displayCategories: ['INTERIOR_BLIND'],
    capabilities: ['RangeController'],
    uuid: 'win-uuid',
    msNo: 1,
    rangeAxisInverted: axisInverted,
  }];
  const structureCache = mockStructure([{
    uuid: 'win-uuid', type: 'Window',
    states: { position: 'win-pos-uuid' },
  }]);
  const stateCache = mockStateCache(position != null ? { 'win-pos-uuid': position } : {});
  return { endpoints, structureCache, stateCache };
}

// Gate environment. No continuous-position command — handler snaps to verbs.
function gateEnv({ position = null, axisInverted = false } = {}) {
  const endpoints = [{
    endpointId: 'alexa-gate-uuid',
    friendlyName: 'Driveway Gate',
    description: 'Driveway Gate (Loxone Gate)',
    displayCategories: ['DOOR'],
    capabilities: ['RangeController'],
    uuid: 'gate-uuid',
    msNo: 1,
    rangeAxisInverted: axisInverted,
  }];
  const structureCache = mockStructure([{
    uuid: 'gate-uuid', type: 'Gate',
    states: { position: 'gate-pos-uuid' },
  }]);
  const stateCache = mockStateCache(position != null ? { 'gate-pos-uuid': position } : {});
  return { endpoints, structureCache, stateCache };
}

// Slider environment. Native range comes from `details`; defaults to 0..100
// but a 15..25 example is more realistic. Value is the raw slider reading.
function sliderEnv({ value = null, min = 0, max = 100, step = 1, axisInverted = false } = {}) {
  const endpoints = [{
    endpointId: 'alexa-slider-uuid',
    friendlyName: 'Heating Setpoint',
    description: 'Heating Setpoint (Loxone Slider)',
    displayCategories: ['OTHER'],
    capabilities: ['RangeController'],
    uuid: 'slider-uuid',
    msNo: 1,
    rangeAxisInverted: axisInverted,
  }];
  const structureCache = mockStructure([{
    uuid: 'slider-uuid', type: 'Slider',
    details: { min, max, step, format: '%d' },
    states: { value: 'slider-val-uuid' },
  }]);
  const stateCache = mockStateCache(value != null ? { 'slider-val-uuid': value } : {});
  return { endpoints, structureCache, stateCache };
}

// IRoomControllerV2 thermostat environment. Three state UUIDs, all
// optional (cold-cache scenarios test what happens when each is missing).
// `details.format` drives the temperature scale.
function thermostatEnv({
  tempActual = null,
  tempTarget = null,
  opMode = null,
  format = '°C',
  useOverride = false,
  overrideHours = 12,
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-tst-uuid',
    friendlyName: 'Bedroom Thermostat',
    description: 'Bedroom Thermostat (Loxone IRoomControllerV2)',
    displayCategories: ['THERMOSTAT'],
    capabilities: ['ThermostatController', 'TemperatureSensor'],
    uuid: 'tst-uuid',
    msNo: 1,
    thermostatUseOverride: useOverride,
    thermostatOverrideHours: overrideHours,
  }];
  const structureCache = mockStructure([{
    uuid: 'tst-uuid', type: 'IRoomControllerV2',
    details: { format },
    states: {
      tempActual:    'tst-actual-uuid',
      tempTarget:    'tst-target-uuid',
      operatingMode: 'tst-mode-uuid',
    },
  }]);
  const values = {};
  if (tempActual != null) values['tst-actual-uuid'] = tempActual;
  if (tempTarget != null) values['tst-target-uuid'] = tempTarget;
  if (opMode     != null) values['tst-mode-uuid']   = opMode;
  return { endpoints, structureCache, stateCache: mockStateCache(values) };
}

// AudioZone(V2) environment. Six independent state UUIDs (volume, power,
// playState, shuffle, repeat, source) all optional — pass null for the
// cold-cache flavor of any state. `version` picks V1 vs V2 (changes the
// source-selection wire format). `sourceListText` lets a test seed a
// custom sourceList JSON; default uses a tiny two-entry list.
function audioEnv({
  version = 'AudioZoneV2',
  volume = null,
  power = null,
  playState = null,
  shuffle = null,
  repeat = null,
  source = null,
  sourceListText = null,
  audioVolumeStep = 5,
  capabilities = ['PowerController', 'Speaker', 'PlaybackController',
                  'PlaybackStateReporter', 'ToggleController', 'ModeController'],
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-aud-uuid',
    friendlyName: 'Kitchen Speakers',
    description: `Kitchen Speakers (Loxone ${version})`,
    displayCategories: ['STREAMING_DEVICE'],
    capabilities,
    uuid: 'aud-uuid',
    msNo: 1,
    audioVolumeStep,
  }];
  const structureCache = mockStructure([{
    uuid: 'aud-uuid', type: version,
    states: {
      volume:     'aud-vol-uuid',
      power:      'aud-pwr-uuid',
      playState:  'aud-play-uuid',
      shuffle:    'aud-shuf-uuid',
      repeat:     'aud-rep-uuid',
      source:     'aud-src-uuid',
      sourceList: 'aud-srclist-uuid',
    },
  }]);
  // The numeric states use mockStateCache; the text state (sourceList)
  // needs a small bespoke wrapper so getText works.
  const values = {};
  if (volume    != null) values['aud-vol-uuid']  = volume;
  if (power     != null) values['aud-pwr-uuid']  = power;
  if (playState != null) values['aud-play-uuid'] = playState;
  if (shuffle   != null) values['aud-shuf-uuid'] = shuffle;
  if (repeat    != null) values['aud-rep-uuid']  = repeat;
  if (source    != null) values['aud-src-uuid']  = source;
  const valueMap = mockStateCache(values);
  const textMap  = new Map();
  if (sourceListText != null) {
    textMap.set('aud-srclist-uuid',
      { text: sourceListText, updatedAt: new Date().toISOString() });
  }
  const stateCache = {
    getValue: valueMap.getValue,
    getText:  (u) => textMap.get(u),
  };
  return { endpoints, structureCache, stateCache };
}

// Two-favorite sourceList JSON for source-selection tests. Slot numbers
// intentionally non-contiguous to confirm we don't assume 1..N.
const SAMPLE_SOURCE_LIST = JSON.stringify({
  getroomfavs_result: [{
    id: 3, type: 4, totalitems: 2, start: 0,
    items: [
      { slot: 1, name: 'Led Zeppelin' },
      { slot: 7, name: 'Dein Mix der Woche' },
    ],
  }],
  command: 'audio/cfg/getroomfavs/3/0/10',
});

// PresenceDetector environment. `active` state (0/1) maps to MotionSensor.
// `polarityInverted` toggles the DETECTED ↔ NOT_DETECTED swap. Default
// false here (NOT the type's default-true) so legacy tests keep their
// asserted values; new polarity tests opt in explicitly. `capabilities`
// + `modeLabelActive`/`Inactive` let the binary-sensor ModeController
// tests opt in to the alternative role with custom slot labels.
function presenceEnv({
  active = null,
  polarityInverted = false,
  capabilities = ['MotionSensor'],
  modeLabelActive = '',
  modeLabelInactive = '',
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-pres-uuid',
    friendlyName: 'Hallway Motion',
    description: 'Hallway Motion (Loxone PresenceDetector)',
    displayCategories: ['MOTION_SENSOR'],
    capabilities: capabilities.slice(),
    uuid: 'pres-uuid',
    msNo: 1,
    sensorPolarityInverted: polarityInverted,
    modeLabelActive,
    modeLabelInactive,
  }];
  const structureCache = mockStructure([{
    uuid: 'pres-uuid', type: 'PresenceDetector',
    states: { active: 'pres-active-uuid' },
  }]);
  const stateCache = mockStateCache(active != null ? { 'pres-active-uuid': active } : {});
  return { endpoints, structureCache, stateCache };
}

// WindowMonitor environment. `windowStates` is a comma-separated text
// state — each entry is a bitmask (1=closed, 2=tilted, 4=open).
function windowMonitorEnv({
  windowStatesText = null,
  polarityInverted = false,
  capabilities = ['ContactSensor'],
  modeLabelActive = '',
  modeLabelInactive = '',
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-wm-uuid',
    friendlyName: 'House Windows',
    description: 'House Windows (Loxone WindowMonitor)',
    displayCategories: ['CONTACT_SENSOR'],
    capabilities: capabilities.slice(),
    uuid: 'wm-uuid',
    msNo: 1,
    sensorPolarityInverted: polarityInverted,
    modeLabelActive,
    modeLabelInactive,
  }];
  const structureCache = mockStructure([{
    uuid: 'wm-uuid', type: 'WindowMonitor',
    states: { windowStates: 'wm-states-uuid' },
  }]);
  // WindowMonitor uses a text state, not a numeric — bespoke mock.
  const textMap = new Map();
  if (windowStatesText != null) {
    textMap.set('wm-states-uuid',
      { text: windowStatesText, updatedAt: new Date().toISOString() });
  }
  const stateCache = {
    getValue: () => undefined,
    getText:  (u) => textMap.get(u),
  };
  return { endpoints, structureCache, stateCache };
}

// InfoOnlyDigital environment. Single 0/1 state; the SAME control can be
// exposed as either ContactSensor or MotionSensor (or both) — caller picks
// via the `capabilities` array. Exercises the dual-role mapping pattern.
function infoOnlyDigitalEnv({
  active = null,
  capabilities = ['ContactSensor'],
  polarityInverted = false,
  modeLabelActive = '',
  modeLabelInactive = '',
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-iod-uuid',
    friendlyName: 'Garage Door Sensor',
    description: 'Garage Door Sensor (Loxone InfoOnlyDigital)',
    displayCategories: capabilities.indexOf('MotionSensor') >= 0
      ? ['MOTION_SENSOR'] : ['CONTACT_SENSOR'],
    capabilities: capabilities.slice(),
    uuid: 'iod-uuid',
    msNo: 1,
    sensorPolarityInverted: polarityInverted,
    modeLabelActive,
    modeLabelInactive,
  }];
  const structureCache = mockStructure([{
    uuid: 'iod-uuid', type: 'InfoOnlyDigital',
    states: { active: 'iod-active-uuid' },
  }]);
  const stateCache = mockStateCache(active != null ? { 'iod-active-uuid': active } : {});
  return { endpoints, structureCache, stateCache };
}

// InfoOnlyAnalog environment. Numeric value state; dual-role (Temperature
// or Humidity). The format string drives the temperature scale (°C/°F);
// humidity ignores it.
function infoOnlyAnalogEnv({
  value = null,
  capabilities = ['TemperatureSensor'],
  format = '%.1f°C',
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-ioa-uuid',
    friendlyName: 'Bedroom Sensor',
    description: 'Bedroom Sensor (Loxone InfoOnlyAnalog)',
    displayCategories: capabilities.indexOf('HumiditySensor') >= 0
      ? ['HUMIDITY_SENSOR'] : ['TEMPERATURE_SENSOR'],
    capabilities: capabilities.slice(),
    uuid: 'ioa-uuid',
    msNo: 1,
  }];
  const structureCache = mockStructure([{
    uuid: 'ioa-uuid', type: 'InfoOnlyAnalog',
    states: { value: 'ioa-value-uuid' },
    details: { format },
  }]);
  const stateCache = mockStateCache(value != null ? { 'ioa-value-uuid': value } : {});
  return { endpoints, structureCache, stateCache };
}

// Radio environment. details.outputs is a {id -> name} map; the test
// helper accepts it as a plain object. `allOff` opt-in surfaces id=0 as
// a slot in Discovery. activeOutput is the currently-selected slot.
function radioEnv({
  outputs = { 1: 'Comfort', 2: 'Eco', 5: 'Frost' },
  allOff = null,
  activeOutput = null,
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-radio-uuid',
    friendlyName: 'Heating Mode',
    description: 'Heating Mode (Loxone Radio)',
    displayCategories: ['OTHER'],
    capabilities: ['ModeController'],
    uuid: 'radio-uuid',
    msNo: 1,
  }];
  const details = { outputs };
  if (allOff != null) details.allOff = allOff;
  const structureCache = mockStructure([{
    uuid: 'radio-uuid', type: 'Radio',
    states: { activeOutput: 'radio-active-uuid' },
    details,
  }]);
  const stateCache = mockStateCache(
    activeOutput != null ? { 'radio-active-uuid': activeOutput } : {}
  );
  return { endpoints, structureCache, stateCache };
}

// Sequential environment. details.sequences is a JSON array (NOT a map
// like Radio's outputs). activeSequence is a numeric state. Slot id 0
// is unconditional "None" — no opt-in flag.
function sequentialEnv({
  sequences = [
    { id: 4, name: 'Gustav' },
    { id: 8, name: 'Karl' },
  ],
  activeSequence = null,
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-seq-uuid',
    friendlyName: 'Light Show',
    description: 'Light Show (Loxone Sequential)',
    displayCategories: ['SCENE_TRIGGER'],
    capabilities: ['ModeController'],
    uuid: 'seq-uuid',
    msNo: 1,
  }];
  const structureCache = mockStructure([{
    uuid: 'seq-uuid', type: 'Sequential',
    states: { activeSequence: 'seq-active-uuid' },
    details: { sequences },
  }]);
  const stateCache = mockStateCache(
    activeSequence != null ? { 'seq-active-uuid': activeSequence } : {}
  );
  return { endpoints, structureCache, stateCache };
}

// ValueSelector environment. min/max/step are STATE UUIDs (not details).
// `increaseOnly` is the only thing in details. Cold-cache simulation by
// omitting any of the four numeric values.
function valueSelectorEnv({
  value = null,
  min = null,
  max = null,
  step = null,
  increaseOnly = false,
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-vs-uuid',
    friendlyName: 'Counter',
    description: 'Counter (Loxone ValueSelector)',
    displayCategories: ['OTHER'],
    capabilities: ['RangeController'],
    uuid: 'vs-uuid',
    msNo: 1,
  }];
  const structureCache = mockStructure([{
    uuid: 'vs-uuid', type: 'ValueSelector',
    states: {
      value: 'vs-value-uuid',
      min:   'vs-min-uuid',
      max:   'vs-max-uuid',
      step:  'vs-step-uuid',
    },
    details: { increaseOnly },
  }]);
  const valueMap = new Map();
  if (value != null) valueMap.set('vs-value-uuid', { value, updatedAt: new Date().toISOString() });
  if (min   != null) valueMap.set('vs-min-uuid',   { value: min,   updatedAt: new Date().toISOString() });
  if (max   != null) valueMap.set('vs-max-uuid',   { value: max,   updatedAt: new Date().toISOString() });
  if (step  != null) valueMap.set('vs-step-uuid',  { value: step,  updatedAt: new Date().toISOString() });
  const stateCache = {
    getValue: (u) => valueMap.get(u),
    getText:  () => undefined,
  };
  return { endpoints, structureCache, stateCache };
}

// Ventilation environment. Exposes the seven states the dispatch reads
// (speed / mode / activeTimerProfile / temperatureIndoor / humidityIndoor)
// plus the details.modes catalogue. Each numeric is optional so tests can
// simulate cold cache for individual states.
function ventilationEnv({
  speed = null,
  mode = null,
  activeTimerProfile = null,
  temperatureIndoor = null,
  humidityIndoor = null,
  modes = [
    { id: 0, name: 'Heat Exchanger' },
    { id: 1, name: 'Exhaust' },
    { id: 2, name: 'Bypass' },
  ],
  capabilities = ['PowerController', 'RangeController', 'ModeController'],
  ventilationOverrideHours = 24,
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-vent-uuid',
    friendlyName: 'Bathroom Ventilation',
    description: 'Bathroom Ventilation (Loxone Ventilation)',
    displayCategories: ['FAN'],
    capabilities: capabilities.slice(),
    uuid: 'vent-uuid',
    msNo: 1,
    ventilationOverrideHours,
  }];
  const structureCache = mockStructure([{
    uuid: 'vent-uuid', type: 'Ventilation',
    states: {
      speed:              'vent-speed-uuid',
      mode:               'vent-mode-uuid',
      activeTimerProfile: 'vent-tp-uuid',
      temperatureIndoor:  'vent-temp-uuid',
      humidityIndoor:     'vent-hum-uuid',
    },
    details: { modes },
  }]);
  const valueMap = new Map();
  if (speed != null)              valueMap.set('vent-speed-uuid', { value: speed, updatedAt: new Date().toISOString() });
  if (mode != null)               valueMap.set('vent-mode-uuid',  { value: mode,  updatedAt: new Date().toISOString() });
  if (activeTimerProfile != null) valueMap.set('vent-tp-uuid',    { value: activeTimerProfile, updatedAt: new Date().toISOString() });
  if (temperatureIndoor != null)  valueMap.set('vent-temp-uuid',  { value: temperatureIndoor,  updatedAt: new Date().toISOString() });
  if (humidityIndoor != null)     valueMap.set('vent-hum-uuid',   { value: humidityIndoor,     updatedAt: new Date().toISOString() });
  const stateCache = {
    getValue: (u) => valueMap.get(u),
    getText:  () => undefined,
  };
  return { endpoints, structureCache, stateCache };
}

// ACControl environment. All five states the dispatch cares about
// (status / mode / fan / temperature / targetTemperature) plus the
// fanspeeds catalogue text state. Each is optional so a test can simulate
// a cold cache by omitting it.
function acControlEnv({
  status = null,
  mode = null,
  fan = null,
  temperature = null,
  targetTemperature = null,
  fanspeedsJson = null,
  minTemp = null,
  maxTemp = null,
  format = '%.1f°C',
} = {}) {
  const endpoints = [{
    endpointId: 'alexa-ac-uuid',
    friendlyName: 'Bedroom AC',
    description: 'Bedroom AC (Loxone ACControl)',
    displayCategories: ['AIR_CONDITIONER'],
    capabilities: [
      'PowerController', 'ThermostatController',
      'TemperatureSensor', 'ModeController',
    ],
    uuid: 'ac-uuid',
    msNo: 1,
  }];
  const structureCache = mockStructure([{
    uuid: 'ac-uuid', type: 'ACControl',
    states: {
      status:            'ac-status-uuid',
      mode:              'ac-mode-uuid',
      fan:               'ac-fan-uuid',
      temperature:       'ac-temp-uuid',
      targetTemperature: 'ac-target-uuid',
      fanspeeds:         'ac-fanspeeds-uuid',
      minTemp:           'ac-mintemp-uuid',
      maxTemp:           'ac-maxtemp-uuid',
    },
    details: { format },
  }]);
  const valueMap = new Map();
  if (status != null)            valueMap.set('ac-status-uuid', { value: status, updatedAt: new Date().toISOString() });
  if (mode != null)              valueMap.set('ac-mode-uuid',   { value: mode,   updatedAt: new Date().toISOString() });
  if (fan != null)               valueMap.set('ac-fan-uuid',    { value: fan,    updatedAt: new Date().toISOString() });
  if (temperature != null)       valueMap.set('ac-temp-uuid',   { value: temperature, updatedAt: new Date().toISOString() });
  if (targetTemperature != null) valueMap.set('ac-target-uuid', { value: targetTemperature, updatedAt: new Date().toISOString() });
  if (minTemp != null)           valueMap.set('ac-mintemp-uuid', { value: minTemp, updatedAt: new Date().toISOString() });
  if (maxTemp != null)           valueMap.set('ac-maxtemp-uuid', { value: maxTemp, updatedAt: new Date().toISOString() });
  const textMap = new Map();
  if (fanspeedsJson != null) textMap.set('ac-fanspeeds-uuid', { text: fanspeedsJson, updatedAt: new Date().toISOString() });
  const stateCache = {
    getValue: (u) => valueMap.get(u),
    getText:  (u) => textMap.get(u),
  };
  return { endpoints, structureCache, stateCache };
}

// LightController (v1) environment. Two states the router cares about:
// `activeScene` (numeric — current scene) and `sceneList` (CSV text
// listing scene id/name pairs). Either can be null to simulate cold
// cache. Endpoint declares PowerController + ModeController so both
// branches of Discovery and ReportState run.
function lightControllerV1Env({ activeScene = null, sceneListText = null } = {}) {
  const endpoints = [{
    endpointId: 'alexa-lc1-uuid',
    friendlyName: 'Living Room Lights',
    description: 'Living Room Lights (Loxone LightController)',
    displayCategories: ['LIGHT'],
    capabilities: ['PowerController', 'ModeController'],
    uuid: 'lc1-uuid',
    msNo: 1,
  }];
  const structureCache = mockStructure([{
    uuid: 'lc1-uuid', type: 'LightController',
    states: { activeScene: 'lc1-scene-uuid', sceneList: 'lc1-list-uuid' },
  }]);
  // Bespoke cache: activeScene is numeric (getValue), sceneList is text
  // (getText). Cover both with one mock so callers can populate either.
  const valueMap = new Map();
  if (activeScene != null) {
    valueMap.set('lc1-scene-uuid',
      { value: activeScene, updatedAt: new Date().toISOString() });
  }
  const textMap = new Map();
  if (sceneListText != null) {
    textMap.set('lc1-list-uuid',
      { text: sceneListText, updatedAt: new Date().toISOString() });
  }
  const stateCache = {
    getValue: (u) => valueMap.get(u),
    getText:  (u) => textMap.get(u),
  };
  return { endpoints, structureCache, stateCache };
}

// One Pushbutton endpoint, UUID-routed. Used for SceneController tests.
function pushbuttonEndpoints() {
  return [{
    endpointId: 'alexa-pb-uuid',
    friendlyName: 'Doorbell',
    description: 'Doorbell (Loxone Pushbutton)',
    displayCategories: ['SCENE_TRIGGER'],
    capabilities: ['SceneController'],
    uuid: 'pb-uuid',
    msNo: 1,
  }];
}

function newRouter(endpoints, opts) {
  opts = opts || {};
  const mock = new MockLoxoneCommand();
  const router = new DirectiveRouter({
    loxoneCommand: mock,
    endpoints: endpoints || defaultEndpointsForTesting(),
    log,
    getGlobals:       opts.getGlobals,
    structureCache:   opts.structureCache,
    stateCache:       opts.stateCache,
  });
  return { router, mock };
}

(async () => {
  await test('Discovery returns the configured endpoint(s)', async () => {
    const { router } = newRouter();
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'm1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    eq(resp?.event?.header?.namespace, 'Alexa.Discovery', 'response namespace');
    eq(resp?.event?.header?.name, 'Discover.Response', 'response name');
    const endpoints = resp?.event?.payload?.endpoints;
    check(Array.isArray(endpoints) && endpoints.length === 1, 'one endpoint returned');
    eq(endpoints[0].endpointId, 'alexa-pluginTest', 'endpointId');
    eq(endpoints[0].friendlyName, 'Plugin Test', 'friendlyName');
    check(endpoints[0].displayCategories?.includes('SWITCH'), 'displayCategories includes SWITCH');
    check(endpoints[0].capabilities?.some((c) => c.interface === 'Alexa'), 'declares Alexa interface');
    check(endpoints[0].capabilities?.some((c) => c.interface === 'Alexa.PowerController'), 'declares PowerController');
  });

  await test('TurnOn writes "On" to Miniserver and returns Alexa.Response', async () => {
    const { router, mock } = newRouter();
    const resp = await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3',
                messageId: 'm2', correlationToken: 'ctk' },
      endpoint: { endpointId: 'alexa-pluginTest', scope: { type: 'BearerToken', token: 't' } },
      payload: {},
    });
    eq(mock.calls.length, 1, 'one Loxone call');
    eq(mock.calls[0].msNo, 1, 'msNo');
    eq(mock.calls[0].name, 'PluginTest', 'VI name');
    eq(mock.calls[0].value, 'On', 'value=On');
    eq(resp?.event?.header?.namespace, 'Alexa', 'namespace');
    eq(resp?.event?.header?.name, 'Response', 'name');
    eq(resp?.event?.header?.correlationToken, 'ctk', 'correlationToken echoed');
    eq(resp?.event?.endpoint?.endpointId, 'alexa-pluginTest', 'endpointId echoed');
    const props = resp?.context?.properties;
    check(Array.isArray(props) && props[0]?.value === 'ON', 'powerState=ON in context');
  });

  await test('TurnOff writes "Off"', async () => {
    const { router, mock } = newRouter();
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOff', payloadVersion: '3', messageId: 'm3' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(mock.calls[0].value, 'Off', 'value=Off');
  });

  await test('TurnOn against unknown endpoint → NO_SUCH_ENDPOINT', async () => {
    const { router, mock } = newRouter();
    const resp = await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'm4' },
      endpoint: { endpointId: 'does-not-exist' },
      payload: {},
    });
    eq(mock.calls.length, 0, 'no Loxone call made');
    eq(resp?.event?.header?.name, 'ErrorResponse', 'returns error');
    eq(resp?.event?.payload?.type, 'NO_SUCH_ENDPOINT', 'NO_SUCH_ENDPOINT');
  });

  await test('Loxone command failure → ENDPOINT_UNREACHABLE', async () => {
    const { router, mock } = newRouter();
    mock.nextResult = { ok: false, exitCode: 1, category: 'exit_nonzero', stdout: 'fail: ms unreachable', stderr: '', durationMs: 5, spawnError: null };
    const resp = await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'm5' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(resp?.event?.header?.name, 'ErrorResponse', 'error envelope');
    eq(resp?.event?.payload?.type, 'ENDPOINT_UNREACHABLE', 'ENDPOINT_UNREACHABLE');
  });

  await test('Unknown directive namespace.name → INVALID_DIRECTIVE', async () => {
    const { router } = newRouter();
    const resp = await router.handle({
      header: { namespace: 'Alexa.CookingController', name: 'StartCooking', payloadVersion: '3', messageId: 'm6' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(resp?.event?.header?.name, 'ErrorResponse', 'error envelope');
    eq(resp?.event?.payload?.type, 'INVALID_DIRECTIVE', 'INVALID_DIRECTIVE');
  });

  await test('Malformed directive (no header) → INVALID_DIRECTIVE', async () => {
    const { router } = newRouter();
    const resp = await router.handle({ payload: {} });
    eq(resp?.event?.payload?.type, 'INVALID_DIRECTIVE', 'INVALID_DIRECTIVE');
  });

  await test('AcceptGrant returns AcceptGrant.Response (no-op)', async () => {
    const { router } = newRouter();
    const resp = await router.handle({
      header: { namespace: 'Alexa.Authorization', name: 'AcceptGrant', payloadVersion: '3', messageId: 'm7' },
      payload: { grant: {}, grantee: {} },
    });
    eq(resp?.event?.header?.name, 'AcceptGrant.Response', 'AcceptGrant.Response');
  });

  await test('ReportState returns StateReport with powerState + connectivity', async () => {
    const { router, mock } = newRouter();
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3',
                messageId: 'm8', correlationToken: 'ctk-rs' },
      endpoint: { endpointId: 'alexa-pluginTest', scope: { type: 'BearerToken', token: 't' } },
      payload: {},
    });
    eq(mock.calls.length, 0, 'ReportState does NOT invoke Loxone command');
    eq(resp?.event?.header?.namespace, 'Alexa', 'namespace=Alexa');
    eq(resp?.event?.header?.name, 'StateReport', 'name=StateReport');
    eq(resp?.event?.header?.correlationToken, 'ctk-rs', 'correlationToken echoed');
    eq(resp?.event?.endpoint?.endpointId, 'alexa-pluginTest', 'endpoint echoed');
    const props = resp?.context?.properties || [];
    const power = props.find((p) => p.namespace === 'Alexa.PowerController');
    const health = props.find((p) => p.namespace === 'Alexa.EndpointHealth');
    check(!!power, 'has PowerController/powerState');
    eq(power?.name, 'powerState', 'power property name');
    check(power?.value === 'ON' || power?.value === 'OFF', 'powerState is ON or OFF');
    check(!!health, 'has EndpointHealth/connectivity');
    eq(health?.value?.value, 'OK', 'connectivity=OK');
  });

  // Regression: post-Discovery StateReport for a Switch must reflect the
  // live Loxone `active` state, not the old hard-coded OFF stub (which
  // forced users to toggle once before Alexa showed the right state).
  function switchEnv({ active = null } = {}) {
    const endpoints = [{
      endpointId: 'alexa-sw-uuid',
      friendlyName: 'Kitchen Outlet',
      displayCategories: ['SWITCH'],
      capabilities: ['PowerController'],
      uuid: 'sw-uuid',
      power: { msNo: 1, name: 'KitchenOutlet', onValue: 'On', offValue: 'Off' },
    }];
    const structureCache = mockStructure([{
      uuid: 'sw-uuid', type: 'Switch', states: { active: 'sw-active-uuid' },
    }]);
    const stateCache = mockStateCache(active != null ? { 'sw-active-uuid': active } : {});
    return { endpoints, structureCache, stateCache };
  }

  async function switchReport(env) {
    const { router } = newRouter(env.endpoints, {
      structureCache: env.structureCache, stateCache: env.stateCache,
    });
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'm8b' },
      endpoint: { endpointId: 'alexa-sw-uuid', scope: { type: 'BearerToken', token: 't' } },
      payload: {},
    });
    return (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.PowerController');
  }

  await test('ReportState: Switch reflects live ON state after Discovery', async () => {
    const p = await switchReport(switchEnv({ active: 1 }));
    eq(p?.value, 'ON', 'live active=1 → ON');
    eq(p?.uncertaintyInMilliseconds, 0, 'resolved value is certain');
  });

  await test('ReportState: Switch reflects live OFF state', async () => {
    const p = await switchReport(switchEnv({ active: 0 }));
    eq(p?.value, 'OFF', 'live active=0 → OFF');
    eq(p?.uncertaintyInMilliseconds, 0, 'resolved value is certain');
  });

  await test('ReportState: Switch with no state yet → OFF stub, high uncertainty', async () => {
    const p = await switchReport(switchEnv({ active: null }));
    eq(p?.value, 'OFF', 'unknown → honest OFF stub');
    check((p?.uncertaintyInMilliseconds || 0) > 0, 'stub stays uncertain until ChangeReport');
  });

  // ---- Dimmer: full end-to-end (write path + both state paths) -----------
  // Regression for the audit finding: Dimmer was in TYPE_MAP but SetBrightness
  // emitted ColorPickerV2 temp()/hsv() (a plain Dimmer can't parse those) and
  // it had zero state reporting. These lock in the native {pos}/off grammar
  // (Structure File V17 p.59) and the position↔brightness round-trip.
  function dimmerEnv({ position = null, min, max } = {}) {
    const endpoints = [{
      endpointId: 'alexa-dim-uuid',
      friendlyName: 'Hallway Light',
      displayCategories: ['LIGHT'],
      capabilities: ['PowerController', 'BrightnessController'],
      uuid: 'dim-uuid',
      msNo: 1,
    }];
    const structureCache = mockStructure([{
      uuid: 'dim-uuid', type: 'Dimmer',
      states: { position: 'dim-pos', min: 'dim-min', max: 'dim-max' },
    }]);
    const vals = {};
    if (position != null) vals['dim-pos'] = position;
    if (min != null) vals['dim-min'] = min;
    if (max != null) vals['dim-max'] = max;
    return { endpoints, structureCache, stateCache: mockStateCache(vals) };
  }

  function dimmerRouter(env) {
    return newRouter(env.endpoints, {
      structureCache: env.structureCache, stateCache: env.stateCache,
    });
  }

  async function setBrightness(router, brightness) {
    return router.handle({
      header: { namespace: 'Alexa.BrightnessController', name: 'SetBrightness',
                payloadVersion: '3', messageId: 'mdim', correlationToken: 'ct' },
      endpoint: { endpointId: 'alexa-dim-uuid', scope: { type: 'BearerToken', token: 't' } },
      payload: { brightness },
    });
  }

  await test('Dimmer SetBrightness sends native {pos}, never temp()/hsv()', async () => {
    const { router, mock } = dimmerRouter(dimmerEnv({ position: 0 }));
    await setBrightness(router, 42);
    eq(mock.calls.length, 1, 'one Loxone command');
    eq(mock.calls[0].kind, 'uuid', 'sent by uuid');
    eq(mock.calls[0].command, '42', 'bare numeric position (default 0..100 range)');
    check(!/temp\(|hsv\(/.test(mock.calls[0].command), 'no ColorPicker grammar');
  });

  await test('Dimmer SetBrightness 0 → Loxone `off` (not position min)', async () => {
    const { router, mock } = dimmerRouter(dimmerEnv({ position: 80 }));
    await setBrightness(router, 0);
    eq(mock.calls[0].command, 'off', 'brightness 0 turns the dimmer off');
  });

  await test('Dimmer SetBrightness honors a configured [min,max] range', async () => {
    // min=10,max=50: Alexa 50% → 10 + 0.5*(40) = 30.
    const { router, mock } = dimmerRouter(dimmerEnv({ position: 10, min: 10, max: 50 }));
    await setBrightness(router, 50);
    eq(mock.calls[0].command, '30', 'Alexa 50% maps into native [10,50]');
  });

  await test('Dimmer AdjustBrightness uses live position as the base', async () => {
    const { router, mock } = dimmerRouter(dimmerEnv({ position: 30 }));
    await router.handle({
      header: { namespace: 'Alexa.BrightnessController', name: 'AdjustBrightness',
                payloadVersion: '3', messageId: 'mdim2' },
      endpoint: { endpointId: 'alexa-dim-uuid', scope: { type: 'BearerToken', token: 't' } },
      payload: { brightnessDelta: 10 },
    });
    eq(mock.calls[0].command, '40', '30 + 10 → 40');
  });

  async function dimmerReport(env) {
    const { router } = dimmerRouter(env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mdimr' },
      endpoint: { endpointId: 'alexa-dim-uuid', scope: { type: 'BearerToken', token: 't' } },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    return {
      power: props.find((p) => p.namespace === 'Alexa.PowerController'),
      bri:   props.find((p) => p.namespace === 'Alexa.BrightnessController'),
    };
  }

  await test('Dimmer ReportState reflects live position (ON + brightness)', async () => {
    const { power, bri } = await dimmerReport(dimmerEnv({ position: 75 }));
    eq(power?.value, 'ON', 'position 75 → ON');
    eq(power?.uncertaintyInMilliseconds, 0, 'resolved → certain');
    eq(bri?.value, 75, 'brightness 75 (default 0..100 range)');
  });

  await test('Dimmer ReportState at position 0 → OFF, brightness 0', async () => {
    const { power, bri } = await dimmerReport(dimmerEnv({ position: 0 }));
    eq(power?.value, 'OFF', 'position 0 → OFF');
    eq(bri?.value, 0, 'brightness 0');
  });

  await test('Dimmer ReportState scales a configured [min,max] back to 0..100', async () => {
    const { bri } = await dimmerReport(dimmerEnv({ position: 30, min: 10, max: 50 }));
    eq(bri?.value, 50, 'native 30 in [10,50] → Alexa 50%');
  });

  await test('Dimmer ReportState with no position yet → OFF stub, uncertain', async () => {
    const { power } = await dimmerReport(dimmerEnv({ position: null }));
    eq(power?.value, 'OFF', 'unknown → honest OFF stub');
    check((power?.uncertaintyInMilliseconds || 0) > 0, 'stays uncertain until a real state arrives');
  });

  await test('ReportState against unknown endpoint → NO_SUCH_ENDPOINT', async () => {
    const { router } = newRouter();
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'm9' },
      endpoint: { endpointId: 'no-such-thing' },
      payload: {},
    });
    eq(resp?.event?.header?.name, 'ErrorResponse', 'error envelope');
    eq(resp?.event?.payload?.type, 'NO_SUCH_ENDPOINT', 'NO_SUCH_ENDPOINT');
  });

  await test('Discovery now advertises EndpointHealth capability', async () => {
    const { router } = newRouter();
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'm10' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const hasHealth = ep?.capabilities?.some((c) => c.interface === 'Alexa.EndpointHealth');
    check(hasHealth, 'declares Alexa.EndpointHealth');
  });

  // ---- Vacation gate -------------------------------------------------------

  // New model: the gate watches a user-chosen Loxone control. We mock a
  // 'gate-ctrl' Switch whose `active` state UUID is 'gate-st'; `gateValue`
  // is what the state cache holds for it (undefined/null = cold cache).
  // The gate accepts ONLY a Loxone Virtual Status (InfoOnlyDigital).
  const GATE_CTRL = 'gate-ctrl';
  function gatedRouter(globalsConfig, gateValue) {
    const structureCache = mockStructure([
      { uuid: GATE_CTRL, type: 'InfoOnlyDigital', states: { active: 'gate-st' } },
    ]);
    const stateCache = mockStateCache(gateValue == null ? {} : { 'gate-st': gateValue });
    return newRouter(undefined, {
      getGlobals: () => globalsConfig, structureCache, stateCache,
    });
  }

  // For tests that already supply a device env (jalousie/slider/…) and just
  // need the gate ON: inject a synthetic Virtual Status control 'vg-ctrl'
  // (InfoOnlyDigital, the only accepted type) by composing over the env's
  // structureCache, and layer its truthy `active` value over the state cache.
  function gateOpts(env, on = true) {
    const baseSt = env.stateCache || { getValue: () => undefined, getText: () => undefined };
    const baseStruct = env.structureCache;
    const gateCtrl = { uuid: 'vg-ctrl', type: 'InfoOnlyDigital', states: { active: 'vg-st' } };
    return {
      ...env,
      getGlobals: () => ({ enabled: true, vacationGate: { enabled: true, controlUuid: 'vg-ctrl' } }),
      structureCache: {
        ...baseStruct,
        getControl: (u) => (u === 'vg-ctrl' ? gateCtrl
          : (baseStruct && baseStruct.getControl ? baseStruct.getControl(u) : null)),
        getCatalogue: baseStruct && baseStruct.getCatalogue
          ? baseStruct.getCatalogue.bind(baseStruct) : undefined,
      },
      stateCache: {
        getValue: (u) => (u === 'vg-st' ? { value: on ? 1 : 0 } : baseSt.getValue(u)),
        getText:  (u) => (baseSt.getText ? baseSt.getText(u) : undefined),
      },
    };
  }

  await test('Vacation gate OFF → writes pass through normally', async () => {
    const { router, mock } = gatedRouter({ enabled: true, vacationGate: { enabled: false, controlUuid: GATE_CTRL } }, 1);
    const resp = await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'mvg1' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(mock.calls.length, 1, 'Loxone called');
    eq(resp?.event?.header?.name, 'Response', 'Alexa.Response');
  });

  await test('Vacation gate ON but watched control is OFF → writes pass through', async () => {
    const { router, mock } = gatedRouter(
      { enabled: true, vacationGate: { enabled: true, controlUuid: GATE_CTRL } },
      0,  // control state value 0 → not active
    );
    const resp = await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'mvg2' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(mock.calls.length, 1, 'Loxone called');
    eq(resp?.event?.header?.name, 'Response', 'Alexa.Response');
  });

  await test('Vacation gate ON + watched control ON → write rejected with NOT_IN_OPERATION', async () => {
    const { router, mock } = gatedRouter(
      { enabled: true, vacationGate: { enabled: true, controlUuid: GATE_CTRL } },
      1,  // control active → gate blocks
    );
    const resp = await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'mvg3' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(mock.calls.length, 0, 'Loxone NOT called');
    eq(resp?.event?.header?.name, 'ErrorResponse', 'ErrorResponse');
    eq(resp?.event?.payload?.type, 'NOT_IN_OPERATION', 'NOT_IN_OPERATION');
  });

  await test('Vacation gate ON + control ON → ReportState still passes (read-only)', async () => {
    const { router } = gatedRouter(
      { enabled: true, vacationGate: { enabled: true, controlUuid: GATE_CTRL } },
      1,
    );
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mvg4' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(resp?.event?.header?.name, 'StateReport', 'StateReport (not blocked)');
  });

  await test('Vacation gate ON + control ON → Discovery still passes (read-only)', async () => {
    const { router } = gatedRouter(
      { enabled: true, vacationGate: { enabled: true, controlUuid: GATE_CTRL } },
      1,
    );
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'mvg5' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    eq(resp?.event?.header?.name, 'Discover.Response', 'Discover.Response (not blocked)');
  });

  await test('Vacation gate ON but control value unknown (cold cache) → fail-open', async () => {
    const { router, mock } = gatedRouter(
      { enabled: true, vacationGate: { enabled: true, controlUuid: GATE_CTRL } },
      null,  // state cache hasn't seen the value yet
    );
    const resp = await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'mvg6' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(mock.calls.length, 1, 'fail-open: Loxone called despite gate config');
    eq(resp?.event?.header?.name, 'Response', 'Alexa.Response');
  });

  await test('Vacation gate ON but controlUuid unset → fail-open', async () => {
    const { router, mock } = gatedRouter(
      { enabled: true, vacationGate: { enabled: true, controlUuid: null } },
      1,
    );
    const resp = await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'mvg7' },
      endpoint: { endpointId: 'alexa-pluginTest' },
      payload: {},
    });
    eq(mock.calls.length, 1, 'fail-open: Loxone called');
  });

  // ---- RangeController (Jalousie / Window / Gate / Slider) ----------------

  await test('Jalousie Discovery advertises RangeController with Blind presets', async () => {
    const env = jalousieEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'mb1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const range = ep?.capabilities?.find((c) => c.interface === 'Alexa.RangeController');
    check(!!range, 'declares Alexa.RangeController');
    eq(range?.instance, 'Aloxberry.Blind.Position', 'Blind instance');
    eq(range?.configuration?.supportedRange?.minimumValue, 0, 'range min=0');
    eq(range?.configuration?.supportedRange?.maximumValue, 100, 'range max=100');
    const presets = range?.configuration?.presets || [];
    eq(presets.length, 3, 'three presets');
    const openPreset  = presets.find((p) => p.rangeValue === 100);
    const closePreset = presets.find((p) => p.rangeValue === 0);
    const openAssets  = (openPreset?.presetResources?.friendlyNames || [])
      .filter((n) => n['@type'] === 'asset').map((n) => n.value?.assetId);
    const closeAssets = (closePreset?.presetResources?.friendlyNames || [])
      .filter((n) => n['@type'] === 'asset').map((n) => n.value?.assetId);
    check(openAssets.includes('Alexa.Value.Open'),   'Open asset binds to rangeValue=100');
    check(closeAssets.includes('Alexa.Value.Close'), 'Close asset binds to rangeValue=0');
    check(!ep?.capabilities?.some((c) => c.interface === 'Alexa.PowerController'),
      'Jalousie does NOT advertise PowerController');
  });

  await test('Jalousie — axis-inverted default: SetRangeValue 70 → ManualPosition/30', async () => {
    const env = jalousieEnv();  // rangeAxisInverted: true
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mb2', correlationToken: 'ctk-b' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: { rangeValue: 70 },
    });
    eq(mock.calls.length, 1, 'one Loxone call');
    eq(mock.calls[0].command, 'ManualPosition/30', '70% open mirrored → 30');
    eq(resp?.event?.header?.correlationToken, 'ctk-b', 'correlationToken echoed');
    eq((resp?.context?.properties || [])[0]?.value, 70, 'echoed rangeValue=70');
  });

  await test('Jalousie — SetRangeValue 100 (open) → ManualPosition/0', async () => {
    const env = jalousieEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mb2b' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: { rangeValue: 100 },
    });
    eq(mock.calls[0].command, 'ManualPosition/0', '100% open ↔ 0% closed');
  });

  await test('Jalousie — SetRangeValue 0 (closed) → ManualPosition/100', async () => {
    const env = jalousieEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mb2c' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: { rangeValue: 0 },
    });
    eq(mock.calls[0].command, 'ManualPosition/100', '0% open ↔ 100% closed');
  });

  await test('Jalousie — clamps out-of-range to [0,100]', async () => {
    const env = jalousieEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mb3' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: { rangeValue: 250 },
    });
    eq(mock.calls[0].command, 'ManualPosition/0', '250 clamps to 100 → 0 closed');
  });

  await test('Jalousie — invalid payload → INVALID_DIRECTIVE', async () => {
    const env = jalousieEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mb4' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: {},
    });
    eq(mock.calls.length, 0, 'no Loxone call');
    eq(resp?.event?.payload?.type, 'INVALID_DIRECTIVE', 'INVALID_DIRECTIVE');
  });

  await test('Jalousie — AdjustRangeValue with cached position adds delta in Alexa-space', async () => {
    const env = jalousieEnv({ position: 0.30 });  // 30% closed → 70% open in Alexa
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'AdjustRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mb5' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: { rangeValueDelta: 20 },
    });
    eq(mock.calls[0].command, 'ManualPosition/10', '70 + 20 = 90 open ↔ 10 closed');
  });

  await test('Jalousie — AdjustRangeValue cold cache assumes max (100, open)', async () => {
    const env = jalousieEnv({ position: null });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'AdjustRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mb6' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: { rangeValueDelta: -25 },
    });
    eq(mock.calls[0].command, 'ManualPosition/25', '100 − 25 = 75 open ↔ 25 closed');
  });

  await test('Jalousie — ReportState applies axis inversion on read', async () => {
    const env = jalousieEnv({ position: 0.65 });  // 65% closed → 35% open in Alexa
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mb8' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: {},
    });
    eq(mock.calls.length, 0, 'ReportState does NOT command Loxone');
    const range = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.RangeController');
    eq(range?.value, 35, '0.65 closed → 35 open');
    eq(range?.instance, 'Aloxberry.Blind.Position', 'Blind instance');
  });

  await test('Jalousie — ReportState omits rangeValue on cold cache', async () => {
    const env = jalousieEnv({ position: null });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mb9' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    check(!props.some((p) => p.namespace === 'Alexa.RangeController'),
      'no rangeValue when state cache is cold');
    check(props.some((p) => p.namespace === 'Alexa.EndpointHealth'),
      'EndpointHealth still present');
  });

  await test('Jalousie with axis flag overridden to false — no inversion', async () => {
    // User flips the picker checkbox off (unusual motor wiring).
    const env = jalousieEnv({ position: 0.30, axisInverted: false });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mb-override' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: { rangeValue: 70 },
    });
    eq(mock.calls[0].command, 'ManualPosition/70', 'no inversion → 70 passes through');
  });

  // --- Window (no inversion default, moveToPosition verb) ------------------

  await test('Window — SetRangeValue uses moveToPosition without inversion', async () => {
    const env = windowEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mw1' },
      endpoint: { endpointId: 'alexa-win-uuid' },
      payload: { rangeValue: 70 },
    });
    eq(mock.calls[0].command, 'moveToPosition/70', 'pass-through');
  });

  await test('Window — ReportState reads position without inversion', async () => {
    const env = windowEnv({ position: 0.40 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mw2' },
      endpoint: { endpointId: 'alexa-win-uuid' },
      payload: {},
    });
    const range = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.RangeController');
    eq(range?.value, 40, '0.40 → 40 (no inversion)');
  });

  // --- Gate (snap-to-presets) ----------------------------------------------

  await test('Gate — SetRangeValue 100 → open verb', async () => {
    const env = gateEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mg1' },
      endpoint: { endpointId: 'alexa-gate-uuid' },
      payload: { rangeValue: 100 },
    });
    eq(mock.calls[0].command, 'open', 'snap to open');
  });

  await test('Gate — SetRangeValue 0 → close verb', async () => {
    const env = gateEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mg2' },
      endpoint: { endpointId: 'alexa-gate-uuid' },
      payload: { rangeValue: 0 },
    });
    eq(mock.calls[0].command, 'close', 'snap to close');
  });

  await test('Gate — SetRangeValue 50 → PartiallyOpen verb', async () => {
    const env = gateEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mg3' },
      endpoint: { endpointId: 'alexa-gate-uuid' },
      payload: { rangeValue: 50 },
    });
    eq(mock.calls[0].command, 'PartiallyOpen', 'snap to partial');
  });

  await test('Gate — ReportState reads continuous position', async () => {
    const env = gateEnv({ position: 0.42 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mg4' },
      endpoint: { endpointId: 'alexa-gate-uuid' },
      payload: {},
    });
    const range = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.RangeController');
    eq(range?.value, 42, 'continuous position survives even though write snaps');
  });

  // --- Slider (native range, separate instance) ----------------------------

  await test('Slider Discovery advertises native range + Slider instance', async () => {
    const env = sliderEnv({ min: 15, max: 25, step: 0.5 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ms1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const range = ep?.capabilities?.find((c) => c.interface === 'Alexa.RangeController');
    eq(range?.instance, 'Aloxberry.Slider.Value', 'Slider instance');
    eq(range?.configuration?.supportedRange?.minimumValue, 15, 'min from details');
    eq(range?.configuration?.supportedRange?.maximumValue, 25, 'max from details');
    eq(range?.configuration?.supportedRange?.precision, 0.5, 'step from details');
    check(!range?.configuration?.presets, 'no presets for Slider');
    check(!range?.configuration?.unitOfMeasure, 'no fixed unit for Slider');
  });

  await test('Slider — SetRangeValue sends raw value in native range', async () => {
    const env = sliderEnv({ min: 15, max: 25, step: 0.5 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Slider.Value', messageId: 'ms2' },
      endpoint: { endpointId: 'alexa-slider-uuid' },
      payload: { rangeValue: 22 },
    });
    eq(mock.calls[0].command, '22', 'raw value as wire command');
  });

  await test('Slider — SetRangeValue clamps to native range', async () => {
    const env = sliderEnv({ min: 15, max: 25 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Slider.Value', messageId: 'ms3' },
      endpoint: { endpointId: 'alexa-slider-uuid' },
      payload: { rangeValue: 50 },
    });
    eq(mock.calls[0].command, '25', '50 clamps to max=25');
  });

  await test('Slider — AdjustRangeValue with cached value adds delta in native scale', async () => {
    const env = sliderEnv({ value: 20, min: 15, max: 25 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'AdjustRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Slider.Value', messageId: 'ms4' },
      endpoint: { endpointId: 'alexa-slider-uuid' },
      payload: { rangeValueDelta: 2 },
    });
    eq(mock.calls[0].command, '22', '20 + 2 = 22');
  });

  await test('Slider — AdjustRangeValue cold cache falls back to min', async () => {
    const env = sliderEnv({ value: null, min: 15, max: 25 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'AdjustRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Slider.Value', messageId: 'ms5' },
      endpoint: { endpointId: 'alexa-slider-uuid' },
      payload: { rangeValueDelta: 3 },
    });
    eq(mock.calls[0].command, '18', 'min(15) + 3 = 18');
  });

  await test('Slider — ReportState returns native value without scaling', async () => {
    const env = sliderEnv({ value: 21.5, min: 15, max: 25, step: 0.5 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ms6' },
      endpoint: { endpointId: 'alexa-slider-uuid' },
      payload: {},
    });
    const range = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.RangeController');
    eq(range?.value, 21.5, '21.5 passes through verbatim');
    eq(range?.instance, 'Aloxberry.Slider.Value', 'Slider instance');
  });

  await test('Slider — axis inversion mirrors around midpoint of native range', async () => {
    const env = sliderEnv({ min: 0, max: 100, axisInverted: true });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Slider.Value', messageId: 'ms7' },
      endpoint: { endpointId: 'alexa-slider-uuid' },
      payload: { rangeValue: 30 },
    });
    eq(mock.calls[0].command, '70', 'mirrored: 100+0-30 = 70');
  });

  // --- Vacation gate -------------------------------------------------------

  await test('Vacation gate blocks SetRangeValue (write)', async () => {
    const env = jalousieEnv();
    const { router, mock } = newRouter(env.endpoints, gateOpts(env));
    const resp = await router.handle({
      header: { namespace: 'Alexa.RangeController', name: 'SetRangeValue', payloadVersion: '3',
                instance: 'Aloxberry.Blind.Position', messageId: 'mbvg' },
      endpoint: { endpointId: 'alexa-jal-uuid' },
      payload: { rangeValue: 50 },
    });
    eq(mock.calls.length, 0, 'Loxone NOT called');
    eq(resp?.event?.payload?.type, 'NOT_IN_OPERATION', 'NOT_IN_OPERATION');
  });

  // ---- SceneController (Pushbutton) ---------------------------------------

  await test('Discovery for Pushbutton advertises SceneController with supportsDeactivation=false', async () => {
    const { router } = newRouter(pushbuttonEndpoints());
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'msc1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const scene = ep?.capabilities?.find((c) => c.interface === 'Alexa.SceneController');
    check(!!scene, 'declares Alexa.SceneController');
    eq(scene?.supportsDeactivation, false, 'supportsDeactivation=false (momentary)');
    check(!scene?.properties, 'no properties block (scenes are events, not state)');
  });

  await test('SceneController.Activate sends Pulse to the Loxone UUID', async () => {
    const { router, mock } = newRouter(pushbuttonEndpoints());
    const resp = await router.handle({
      header: { namespace: 'Alexa.SceneController', name: 'Activate', payloadVersion: '3',
                messageId: 'msc2', correlationToken: 'ctk-sc' },
      endpoint: { endpointId: 'alexa-pb-uuid' },
      payload: { cause: { type: 'VOICE_INTERACTION' } },
    });
    eq(mock.calls.length, 1, 'one Loxone call');
    eq(mock.calls[0].kind, 'uuid', 'routed via sendByUuid');
    eq(mock.calls[0].uuid, 'pb-uuid', 'uuid');
    eq(mock.calls[0].command, 'Pulse', 'Pulse verb');
    // Critical: SceneController has its OWN response namespace, not Alexa
    eq(resp?.event?.header?.namespace, 'Alexa.SceneController', 'response namespace');
    eq(resp?.event?.header?.name, 'ActivationStarted', 'response name');
    eq(resp?.event?.header?.correlationToken, 'ctk-sc', 'correlationToken echoed');
    eq(resp?.event?.endpoint?.endpointId, 'alexa-pb-uuid', 'endpoint echoed');
    eq(resp?.event?.payload?.cause?.type, 'VOICE_INTERACTION', 'cause echoed verbatim');
    check(typeof resp?.event?.payload?.timestamp === 'string', 'timestamp is ISO string');
  });

  await test('SceneController.Activate without cause defaults to APP_INTERACTION', async () => {
    const { router } = newRouter(pushbuttonEndpoints());
    const resp = await router.handle({
      header: { namespace: 'Alexa.SceneController', name: 'Activate', payloadVersion: '3', messageId: 'msc3' },
      endpoint: { endpointId: 'alexa-pb-uuid' },
      payload: {},
    });
    eq(resp?.event?.payload?.cause?.type, 'APP_INTERACTION', 'fallback cause');
  });

  await test('SceneController.Activate against unknown endpoint → NO_SUCH_ENDPOINT', async () => {
    const { router, mock } = newRouter(pushbuttonEndpoints());
    const resp = await router.handle({
      header: { namespace: 'Alexa.SceneController', name: 'Activate', payloadVersion: '3', messageId: 'msc4' },
      endpoint: { endpointId: 'alexa-not-a-thing' },
      payload: {},
    });
    eq(mock.calls.length, 0, 'no Loxone call');
    eq(resp?.event?.payload?.type, 'NO_SUCH_ENDPOINT', 'NO_SUCH_ENDPOINT');
  });

  await test('SceneController.Activate Loxone failure → ENDPOINT_UNREACHABLE', async () => {
    const { router, mock } = newRouter(pushbuttonEndpoints());
    mock.nextResult = { ok: false, exitCode: 1, category: 'exit_nonzero', stdout: 'fail: 404', stderr: '', durationMs: 5, spawnError: null };
    const resp = await router.handle({
      header: { namespace: 'Alexa.SceneController', name: 'Activate', payloadVersion: '3', messageId: 'msc5' },
      endpoint: { endpointId: 'alexa-pb-uuid' },
      payload: {},
    });
    eq(resp?.event?.payload?.type, 'ENDPOINT_UNREACHABLE', 'ENDPOINT_UNREACHABLE');
  });

  await test('Vacation gate blocks SceneController.Activate (write)', async () => {
    const { router, mock } = newRouter(pushbuttonEndpoints(), {
      getGlobals: () => ({ enabled: true, vacationGate: { enabled: true, controlUuid: 'vg-ctrl' } }),
      structureCache: mockStructure([
        { uuid: 'vg-ctrl', type: 'InfoOnlyDigital', states: { active: 'vg-st' } },
      ]),
      stateCache: {
        getValue: (u) => (u === 'vg-st' ? { value: 1 } : undefined),
        getText:  () => undefined,
      },
    });
    const resp = await router.handle({
      header: { namespace: 'Alexa.SceneController', name: 'Activate', payloadVersion: '3', messageId: 'msc-vg' },
      endpoint: { endpointId: 'alexa-pb-uuid' },
      payload: {},
    });
    eq(mock.calls.length, 0, 'Loxone NOT called');
    eq(resp?.event?.payload?.type, 'NOT_IN_OPERATION', 'NOT_IN_OPERATION');
  });

  // ---- ThermostatController (IRoomControllerV2) ----------------------------

  await test('Thermostat Discovery advertises ThermostatController + TemperatureSensor', async () => {
    const env = thermostatEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'mt1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const tstat = ep?.capabilities?.find((c) => c.interface === 'Alexa.ThermostatController');
    const sensor = ep?.capabilities?.find((c) => c.interface === 'Alexa.TemperatureSensor');
    check(!!tstat,  'declares ThermostatController');
    check(!!sensor, 'declares TemperatureSensor');
    eq(tstat?.configuration?.supportsScheduling, false, 'no scheduling in v1');
    const modes = tstat?.configuration?.supportedModes || [];
    check(modes.includes('AUTO') && modes.includes('HEAT')
       && modes.includes('COOL') && modes.includes('OFF'),
      'four supportedModes');
  });

  await test('SetTargetTemperature (permanent mode) → setComfortTemperature', async () => {
    const env = thermostatEnv({ useOverride: false });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature',
                payloadVersion: '3', messageId: 'mt2', correlationToken: 'ctk-t' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { targetSetpoint: { value: 22, scale: 'CELSIUS' } },
    });
    eq(mock.calls.length, 1, 'one Loxone call');
    eq(mock.calls[0].command, 'setComfortTemperature/22', 'permanent write');
    eq(resp?.event?.header?.correlationToken, 'ctk-t', 'correlationToken echoed');
    const prop = (resp?.context?.properties || [])[0];
    eq(prop?.namespace, 'Alexa.ThermostatController', 'response has thermostat property');
    eq(prop?.value?.value, 22, 'echoed value');
    eq(prop?.value?.scale, 'CELSIUS', 'echoed scale');
  });

  await test('SetTargetTemperature (override mode) → override/3/<until>/<temp>', async () => {
    const env = thermostatEnv({ useOverride: true, overrideHours: 4 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature',
                payloadVersion: '3', messageId: 'mt3' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { targetSetpoint: { value: 21.5, scale: 'CELSIUS' } },
    });
    const cmd = mock.calls[0].command;
    // Pattern: override/3/<until>/<21.5> where until is roughly now+4h
    // in Loxone-epoch seconds. We can't assert exact `until` without
    // mocking Date.now, so just verify shape.
    check(/^override\/3\/\d+\/21\.5$/.test(cmd), 'override command shape: ' + cmd);
    // Parse out the `until` and check it's in the right ballpark (4h
    // ahead of now, with Loxone-epoch offset of 1230768000).
    const until = Number(cmd.split('/')[2]);
    const expectedUntil = Math.floor(Date.now() / 1000) - 1230768000 + 4 * 3600;
    check(Math.abs(until - expectedUntil) < 5, 'until is ~now+4h in Loxone-epoch');
  });

  await test('SetTargetTemperature rounds to 0.5° granularity', async () => {
    const env = thermostatEnv({ useOverride: false });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature',
                payloadVersion: '3', messageId: 'mt4' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { targetSetpoint: { value: 22.345617, scale: 'CELSIUS' } },
    });
    eq(mock.calls[0].command, 'setComfortTemperature/22.5', 'rounded to .5');
  });

  await test('SetTargetTemperature clamps to [5, 35] °C', async () => {
    const env = thermostatEnv({ useOverride: false });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature',
                payloadVersion: '3', messageId: 'mt5' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { targetSetpoint: { value: 99, scale: 'CELSIUS' } },
    });
    eq(mock.calls[0].command, 'setComfortTemperature/35', 'clamped to 35');
  });

  await test('AdjustTargetTemperature adds delta to cached target', async () => {
    const env = thermostatEnv({ tempTarget: 20.0, useOverride: false });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'AdjustTargetTemperature',
                payloadVersion: '3', messageId: 'mt6' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { targetSetpointDelta: { value: 1.5, scale: 'CELSIUS' } },
    });
    eq(mock.calls[0].command, 'setComfortTemperature/21.5', '20 + 1.5');
  });

  await test('AdjustTargetTemperature on cold cache → INVALID_VALUE', async () => {
    const env = thermostatEnv({ tempTarget: null });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'AdjustTargetTemperature',
                payloadVersion: '3', messageId: 'mt7' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { targetSetpointDelta: { value: 1, scale: 'CELSIUS' } },
    });
    eq(mock.calls.length, 0, 'no Loxone call without baseline');
    eq(resp?.event?.payload?.type, 'INVALID_VALUE', 'INVALID_VALUE for cold cache');
  });

  await test('SetThermostatMode HEAT → setOperatingMode/1', async () => {
    const env = thermostatEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetThermostatMode',
                payloadVersion: '3', messageId: 'mt8' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { thermostatMode: { value: 'HEAT' } },
    });
    eq(mock.calls[0].command, 'setOperatingMode/1', 'HEAT → 1');
    eq((resp?.context?.properties || [])[0]?.value, 'HEAT', 'echoed mode');
  });

  await test('SetThermostatMode OFF → setOperatingMode/-1', async () => {
    const env = thermostatEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetThermostatMode',
                payloadVersion: '3', messageId: 'mt9' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { thermostatMode: { value: 'OFF' } },
    });
    eq(mock.calls[0].command, 'setOperatingMode/-1', 'OFF → -1');
  });

  await test('SetThermostatMode with unknown mode → INVALID_VALUE', async () => {
    const env = thermostatEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetThermostatMode',
                payloadVersion: '3', messageId: 'mt10' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { thermostatMode: { value: 'TEAPOT' } },
    });
    eq(mock.calls.length, 0, 'no Loxone call');
    eq(resp?.event?.payload?.type, 'INVALID_VALUE', 'INVALID_VALUE');
  });

  await test('ReportState returns temperature + targetSetpoint + thermostatMode', async () => {
    const env = thermostatEnv({ tempActual: 19.5, tempTarget: 21.0, opMode: 1 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mt11' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    const temp   = props.find((p) => p.namespace === 'Alexa.TemperatureSensor');
    const target = props.find((p) => p.namespace === 'Alexa.ThermostatController' && p.name === 'targetSetpoint');
    const mode   = props.find((p) => p.namespace === 'Alexa.ThermostatController' && p.name === 'thermostatMode');
    eq(temp?.value?.value,   19.5,    'measured temperature');
    eq(temp?.value?.scale,   'CELSIUS', 'CELSIUS scale');
    eq(target?.value?.value, 21.0,    'target setpoint');
    eq(mode?.value,          'HEAT',  'opMode=1 → HEAT');
  });

  await test('ReportState with Loxone Manual mode (4) maps to Alexa HEAT', async () => {
    const env = thermostatEnv({ tempActual: 20, opMode: 4 }); // Manual, only heating
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mt12' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: {},
    });
    const mode = (resp?.context?.properties || []).find(
      (p) => p.name === 'thermostatMode'
    );
    eq(mode?.value, 'HEAT', 'Manual-Heating (4) collapsed to HEAT');
  });

  await test('Fahrenheit scale detected from details.format', async () => {
    const env = thermostatEnv({ format: '°F', tempActual: 70 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mt13' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: {},
    });
    const temp = (resp?.context?.properties || []).find(
      (p) => p.namespace === 'Alexa.TemperatureSensor'
    );
    eq(temp?.value?.scale, 'FAHRENHEIT', 'F scale');
  });

  await test('Vacation gate blocks SetTargetTemperature (write)', async () => {
    const env = thermostatEnv();
    const { router, mock } = newRouter(env.endpoints, gateOpts(env));
    const resp = await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature',
                payloadVersion: '3', messageId: 'mt14' },
      endpoint: { endpointId: 'alexa-tst-uuid' },
      payload: { targetSetpoint: { value: 22, scale: 'CELSIUS' } },
    });
    eq(mock.calls.length, 0, 'Loxone NOT called');
    eq(resp?.event?.payload?.type, 'NOT_IN_OPERATION', 'NOT_IN_OPERATION');
  });

  // ---- AudioZone (V2) -----------------------------------------------------

  await test('AudioZoneV2 Discovery advertises NO ModeController or ToggleController', async () => {
    // AudioZoneV2 (Loxone Audioserver) supports neither `source/`/`repeat/`
    // (ModeController) nor `shuffle` (ToggleController) — those were V1
    // AudioZone commands. Discovery must advertise neither for V2, even if
    // the device's capabilities still list them (stale/hand-edited
    // devices.json) and a sourceList state is present.
    const env = audioEnv({ sourceListText: SAMPLE_SOURCE_LIST });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ma1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const caps = resp?.event?.payload?.endpoints?.[0]?.capabilities || [];
    const ifaceList = caps.map((c) => c.interface);
    check(ifaceList.includes('Alexa.PowerController'),       'PowerController');
    check(ifaceList.includes('Alexa.Speaker'),               'Speaker');
    check(ifaceList.includes('Alexa.PlaybackController'),    'PlaybackController');
    check(ifaceList.includes('Alexa.PlaybackStateReporter'), 'PlaybackStateReporter');
    const modes = caps.filter((c) => c.interface === 'Alexa.ModeController');
    eq(modes.length, 0, 'no ModeController for AudioZoneV2 (no Repeat, no Source)');
    const toggles = caps.filter((c) => c.interface === 'Alexa.ToggleController');
    eq(toggles.length, 0, 'no ToggleController for AudioZoneV2 (no Shuffle)');
  });

  await test('AudioZone (V1) Discovery advertises Source modes from sourceList', async () => {
    const env = audioEnv({ version: 'AudioZone', sourceListText: SAMPLE_SOURCE_LIST });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ma1v1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const caps = resp?.event?.payload?.endpoints?.[0]?.capabilities || [];
    const modes = caps.filter((c) => c.interface === 'Alexa.ModeController');
    eq(modes.length, 2, 'two ModeControllers (Repeat, Source) for V1');
    const sourceMode = modes.find((m) => m.instance === 'Aloxberry.Audio.Source');
    check(!!sourceMode, 'Source instance present for V1');
    const sourceLabels = (sourceMode?.configuration?.supportedModes || [])
      .map((m) => m.modeResources?.friendlyNames?.[0]?.value?.text);
    check(sourceLabels.includes('Led Zeppelin'),       'source name from sourceList');
    check(sourceLabels.includes('Dein Mix der Woche'), 'second source from sourceList');
    // Non-contiguous slots from the sample (1 and 7) become the mode values.
    const values = (sourceMode?.configuration?.supportedModes || []).map((m) => m.value);
    check(values.includes('1') && values.includes('7'), 'slot ids (non-contiguous) used as mode values');
  });

  await test('AudioZone Discovery falls back to numbered sources on cold cache', async () => {
    const env = audioEnv({ version: 'AudioZone', sourceListText: null });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ma2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const caps = resp?.event?.payload?.endpoints?.[0]?.capabilities || [];
    const sourceMode = caps.find((c) => c.interface === 'Alexa.ModeController'
                                    && c.instance === 'Aloxberry.Audio.Source');
    const modes = sourceMode?.configuration?.supportedModes || [];
    eq(modes.length, 8, 'eight generic slots');
    const labels = modes.map((m) => m.modeResources?.friendlyNames?.[0]?.value?.text);
    check(labels.includes('Source 1') && labels.includes('Source 8'),
      'numeric fallback labels');
  });

  await test('SetVolume → volume/<n>', async () => {
    const env = audioEnv({ volume: 30 });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Speaker', name: 'SetVolume', payloadVersion: '3',
                messageId: 'ma3', correlationToken: 'ctk-a' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { volume: 60 },
    });
    eq(mock.calls.length, 1, 'one Loxone call');
    eq(mock.calls[0].command, 'volume/60', 'volume command');
    const prop = (resp?.context?.properties || [])[0];
    eq(prop?.namespace, 'Alexa.Speaker', 'response namespace');
    eq(prop?.value,     60,              'echoed volume');
  });

  await test('AdjustVolume adds explicit delta to cached volume', async () => {
    const env = audioEnv({ volume: 30 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.Speaker', name: 'AdjustVolume', payloadVersion: '3', messageId: 'ma4' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { volume: 15, volumeDefault: false },
    });
    eq(mock.calls[0].command, 'volume/45', 'explicit delta passes through: 30 + 15 = 45');
  });

  await test('AdjustVolume with volumeDefault=true uses configured audioVolumeStep', async () => {
    // User says "louder" without specifying an amount. Alexa sends a small
    // default delta (often 1); we substitute audioVolumeStep (default 5).
    const env = audioEnv({ volume: 30, audioVolumeStep: 7 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.Speaker', name: 'AdjustVolume', payloadVersion: '3', messageId: 'ma4a' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { volume: 1, volumeDefault: true },
    });
    eq(mock.calls[0].command, 'volume/37', '30 + step(7) = 37 (overrode Alexa default of 1)');
  });

  await test('AdjustVolume with volumeDefault=true preserves direction (negative)', async () => {
    const env = audioEnv({ volume: 30, audioVolumeStep: 5 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.Speaker', name: 'AdjustVolume', payloadVersion: '3', messageId: 'ma4b' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { volume: -1, volumeDefault: true },
    });
    eq(mock.calls[0].command, 'volume/25', '30 - step(5) = 25 (sign of -1 preserved)');
  });

  await test('AdjustVolume on cold cache → INVALID_VALUE', async () => {
    const env = audioEnv({ volume: null });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Speaker', name: 'AdjustVolume', payloadVersion: '3', messageId: 'ma5' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { volume: 5 },
    });
    eq(mock.calls.length, 0, 'no Loxone call');
    eq(resp?.event?.payload?.type, 'INVALID_VALUE', 'cold-cache rejection');
  });

  await test('SetMute true → off (Loxone speaker semantics)', async () => {
    const env = audioEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.Speaker', name: 'SetMute', payloadVersion: '3', messageId: 'ma6' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { mute: true },
    });
    eq(mock.calls[0].command, 'off', 'mute=true → off');
  });

  await test('SetMute false → on', async () => {
    const env = audioEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.Speaker', name: 'SetMute', payloadVersion: '3', messageId: 'ma7' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { mute: false },
    });
    eq(mock.calls[0].command, 'on', 'mute=false → on');
  });

  await test('Playback Play / Pause / Stop / Next / Previous → Loxone verbs', async () => {
    const cases = [
      { directive: 'Play',     command: 'play'  },
      { directive: 'Pause',    command: 'pause' },
      { directive: 'Stop',     command: 'pause' },   // closest analog
      { directive: 'Next',     command: 'next'  },
      { directive: 'Previous', command: 'prev'  },
    ];
    for (const c of cases) {
      const env = audioEnv();
      const { router, mock } = newRouter(env.endpoints, env);
      await router.handle({
        header: { namespace: 'Alexa.PlaybackController', name: c.directive,
                  payloadVersion: '3', messageId: 'ma-pb-' + c.directive },
        endpoint: { endpointId: 'alexa-aud-uuid' },
        payload: {},
      });
      eq(mock.calls[0]?.command, c.command, `${c.directive} → ${c.command}`);
    }
  });

  await test('Shuffle TurnOn when off → shuffle command sent', async () => {
    const env = audioEnv({ shuffle: 0 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ToggleController', name: 'TurnOn',
                instance: 'Aloxberry.Audio.Shuffle',
                payloadVersion: '3', messageId: 'ma-sh1' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: {},
    });
    eq(mock.calls.length, 1, 'one toggle');
    eq(mock.calls[0].command, 'shuffle', 'toggle command');
  });

  await test('Shuffle TurnOn when already on → no command', async () => {
    const env = audioEnv({ shuffle: 1 });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.ToggleController', name: 'TurnOn',
                instance: 'Aloxberry.Audio.Shuffle',
                payloadVersion: '3', messageId: 'ma-sh2' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: {},
    });
    eq(mock.calls.length, 0, 'no toggle needed');
    const prop = (resp?.context?.properties || [])[0];
    eq(prop?.value, 'ON', 'still echoed ON');
  });

  await test('SetMode Repeat all → repeat/1', async () => {
    const env = audioEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ModeController', name: 'SetMode',
                instance: 'Aloxberry.Audio.Repeat',
                payloadVersion: '3', messageId: 'ma-r1' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { mode: 'all' },
    });
    eq(mock.calls[0].command, 'repeat/1', "'all' → repeat/1");
  });

  await test('SetMode Repeat one → repeat/3 (Loxone skips value 2)', async () => {
    const env = audioEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ModeController', name: 'SetMode',
                instance: 'Aloxberry.Audio.Repeat',
                payloadVersion: '3', messageId: 'ma-r2' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { mode: 'one' },
    });
    eq(mock.calls[0].command, 'repeat/3', "'one' → repeat/3");
  });

  await test('SetMode Source on AudioZoneV2 → rejected (no favorites API)', async () => {
    // V2 never advertises Source; a stale Alexa endpoint cache that still
    // sends one must be rejected, not blindly fired as playZoneFav/<n>.
    const env = audioEnv({ version: 'AudioZoneV2' });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.ModeController', name: 'SetMode',
                instance: 'Aloxberry.Audio.Source',
                payloadVersion: '3', messageId: 'ma-s1' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { mode: '7' },
    });
    eq(resp?.event?.payload?.type, 'INVALID_VALUE', 'V2 Source rejected with INVALID_VALUE');
    eq(mock.calls.length, 0, 'no Loxone command sent for rejected V2 Source');
  });

  await test('SetMode Source on AudioZone (V1) → source/<slot>', async () => {
    const env = audioEnv({ version: 'AudioZone' });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ModeController', name: 'SetMode',
                instance: 'Aloxberry.Audio.Source',
                payloadVersion: '3', messageId: 'ma-s2' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { mode: '7' },
    });
    eq(mock.calls[0].command, 'source/7', 'V1 → source');
  });

  await test('ReportState for AudioZone returns full property bundle', async () => {
    const env = audioEnv({
      volume: 45, power: 1, playState: 2, shuffle: 1, repeat: 1, source: 3,
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ma-rs' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    const findProp = (ns, name, instance) => props.find(
      (p) => p.namespace === ns && p.name === name
                                && (instance ? p.instance === instance : true)
    );
    eq(findProp('Alexa.Speaker', 'volume')?.value, 45, 'volume');
    eq(findProp('Alexa.Speaker', 'muted')?.value, false, 'muted (false when power=1)');
    eq(findProp('Alexa.PowerController', 'powerState')?.value, 'ON', 'power');
    eq(findProp('Alexa.PlaybackStateReporter', 'playbackState')?.value?.state, 'PLAYING', 'playState');
    eq(findProp('Alexa.ToggleController', 'toggleState', 'Aloxberry.Audio.Shuffle')?.value, 'ON', 'shuffle');
    eq(findProp('Alexa.ModeController', 'mode', 'Aloxberry.Audio.Repeat')?.value, 'all', 'repeat');
    eq(findProp('Alexa.ModeController', 'mode', 'Aloxberry.Audio.Source')?.value, '3', 'source slot');
  });

  await test('ReportState for AudioZone with power=0 reports muted=true', async () => {
    const env = audioEnv({ volume: 30, power: 0 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ma-rs-mute' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    const mutedProp = props.find((p) => p.namespace === 'Alexa.Speaker' && p.name === 'muted');
    eq(mutedProp?.value, true, 'muted=true when power=0');
  });

  await test('Vacation gate blocks audio writes', async () => {
    const env = audioEnv();
    const { router, mock } = newRouter(env.endpoints, gateOpts(env));
    const resp = await router.handle({
      header: { namespace: 'Alexa.Speaker', name: 'SetVolume', payloadVersion: '3', messageId: 'ma-vg' },
      endpoint: { endpointId: 'alexa-aud-uuid' },
      payload: { volume: 50 },
    });
    eq(mock.calls.length, 0, 'gate held');
    eq(resp?.event?.payload?.type, 'NOT_IN_OPERATION', 'NOT_IN_OPERATION');
  });

  // ---- Read-only sensors (PresenceDetector / WindowMonitor) ----------------

  await test('PresenceDetector Discovery advertises Alexa.MotionSensor', async () => {
    const env = presenceEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'mp1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const ms = ep?.capabilities?.find((c) => c.interface === 'Alexa.MotionSensor');
    check(!!ms, 'declares MotionSensor');
    eq(ms?.properties?.supported?.[0]?.name, 'detectionState', 'detectionState supported');
    eq(ms?.properties?.retrievable, true, 'retrievable');
    eq(ms?.properties?.proactivelyReported, true, 'proactivelyReported');
  });

  await test('PresenceDetector ReportState: active=1 → DETECTED', async () => {
    const env = presenceEnv({ active: 1 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mp2' },
      endpoint: { endpointId: 'alexa-pres-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.MotionSensor');
    eq(prop?.value, 'DETECTED', 'active=1 → DETECTED');
  });

  await test('PresenceDetector ReportState: active=0 → NOT_DETECTED', async () => {
    const env = presenceEnv({ active: 0 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mp3' },
      endpoint: { endpointId: 'alexa-pres-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.MotionSensor');
    eq(prop?.value, 'NOT_DETECTED', 'active=0 → NOT_DETECTED');
  });

  await test('PresenceDetector ReportState with cold cache omits MotionSensor', async () => {
    const env = presenceEnv({ active: null });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mp4' },
      endpoint: { endpointId: 'alexa-pres-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    check(!props.some((p) => p.namespace === 'Alexa.MotionSensor'),
      'no detectionState property when cache cold');
  });

  await test('WindowMonitor Discovery advertises Alexa.ContactSensor', async () => {
    const env = windowMonitorEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'mw1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const cs = ep?.capabilities?.find((c) => c.interface === 'Alexa.ContactSensor');
    check(!!cs, 'declares ContactSensor');
    eq(cs?.properties?.supported?.[0]?.name, 'detectionState', 'detectionState supported');
  });

  await test('WindowMonitor: all closed → DETECTED', async () => {
    // Three windows, all reporting bitmask 1 (closed).
    const env = windowMonitorEnv({ windowStatesText: '1,1,1' });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mw2' },
      endpoint: { endpointId: 'alexa-wm-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ContactSensor');
    eq(prop?.value, 'DETECTED', 'all-closed = DETECTED (contact present)');
  });

  await test('WindowMonitor: one open → NOT_DETECTED', async () => {
    // Two closed, one open (bitmask 4).
    const env = windowMonitorEnv({ windowStatesText: '1,4,1' });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mw3' },
      endpoint: { endpointId: 'alexa-wm-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ContactSensor');
    eq(prop?.value, 'NOT_DETECTED', 'any-open = NOT_DETECTED');
  });

  await test('WindowMonitor: tilted counts as not-closed', async () => {
    // Tilted = bitmask 2. Not fully closed → NOT_DETECTED.
    const env = windowMonitorEnv({ windowStatesText: '1,2,1' });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mw4' },
      endpoint: { endpointId: 'alexa-wm-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ContactSensor');
    eq(prop?.value, 'NOT_DETECTED', 'tilted ≠ fully closed');
  });

  await test('WindowMonitor: unknown sensor (state=0) → NOT_DETECTED', async () => {
    // 0 = unknown / sensor offline. Conservative: report not-closed.
    const env = windowMonitorEnv({ windowStatesText: '1,0,1' });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'mw5' },
      endpoint: { endpointId: 'alexa-wm-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ContactSensor');
    eq(prop?.value, 'NOT_DETECTED', 'unknown sensor fails closed');
  });

  // ---- InfoOnlyDigital (dual-role: Motion OR Contact) ---------------------

  await test('InfoOnlyDigital Discovery (Contact role) advertises Alexa.ContactSensor', async () => {
    const env = infoOnlyDigitalEnv({ capabilities: ['ContactSensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'iod1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const cs = ep?.capabilities?.find((c) => c.interface === 'Alexa.ContactSensor');
    const ms = ep?.capabilities?.find((c) => c.interface === 'Alexa.MotionSensor');
    check(!!cs, 'declares ContactSensor');
    check(!ms, 'does not declare MotionSensor when only Contact role selected');
  });

  await test('InfoOnlyDigital Discovery (Motion role) advertises Alexa.MotionSensor', async () => {
    const env = infoOnlyDigitalEnv({ capabilities: ['MotionSensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'iod2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const ms = ep?.capabilities?.find((c) => c.interface === 'Alexa.MotionSensor');
    const cs = ep?.capabilities?.find((c) => c.interface === 'Alexa.ContactSensor');
    check(!!ms, 'declares MotionSensor');
    check(!cs, 'does not declare ContactSensor when only Motion role selected');
  });

  await test('InfoOnlyDigital Discovery (both roles) declares both interfaces', async () => {
    const env = infoOnlyDigitalEnv({ capabilities: ['ContactSensor', 'MotionSensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'iod3' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    check(!!ep?.capabilities?.find((c) => c.interface === 'Alexa.ContactSensor'),
      'declares ContactSensor');
    check(!!ep?.capabilities?.find((c) => c.interface === 'Alexa.MotionSensor'),
      'declares MotionSensor');
  });

  await test('InfoOnlyDigital ReportState (Contact role): active=1 → DETECTED', async () => {
    const env = infoOnlyDigitalEnv({ active: 1, capabilities: ['ContactSensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'iod4' },
      endpoint: { endpointId: 'alexa-iod-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ContactSensor');
    eq(prop?.value, 'DETECTED', 'active=1 → DETECTED');
  });

  await test('InfoOnlyDigital ReportState (Motion role): active=0 → NOT_DETECTED', async () => {
    const env = infoOnlyDigitalEnv({ active: 0, capabilities: ['MotionSensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'iod5' },
      endpoint: { endpointId: 'alexa-iod-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.MotionSensor');
    eq(prop?.value, 'NOT_DETECTED', 'active=0 → NOT_DETECTED');
  });

  await test('InfoOnlyDigital ReportState cold cache omits property', async () => {
    const env = infoOnlyDigitalEnv({ active: null, capabilities: ['ContactSensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'iod6' },
      endpoint: { endpointId: 'alexa-iod-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    check(!props.some((p) => p.namespace === 'Alexa.ContactSensor'),
      'no detectionState when cache cold');
  });

  // ---- InfoOnlyAnalog (dual-role: Temperature OR Humidity) ----------------

  await test('InfoOnlyAnalog Discovery (Temperature role) advertises Alexa.TemperatureSensor', async () => {
    const env = infoOnlyAnalogEnv({ capabilities: ['TemperatureSensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ioa1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const ts = ep?.capabilities?.find((c) => c.interface === 'Alexa.TemperatureSensor');
    const hs = ep?.capabilities?.find((c) => c.interface === 'Alexa.HumiditySensor');
    check(!!ts, 'declares TemperatureSensor');
    check(!hs, 'does not declare HumiditySensor when only Temperature role selected');
    eq(ts?.properties?.supported?.[0]?.name, 'temperature', 'temperature supported');
  });

  await test('InfoOnlyAnalog Discovery (Humidity role) advertises Alexa.HumiditySensor', async () => {
    const env = infoOnlyAnalogEnv({ capabilities: ['HumiditySensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ioa2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const hs = ep?.capabilities?.find((c) => c.interface === 'Alexa.HumiditySensor');
    const ts = ep?.capabilities?.find((c) => c.interface === 'Alexa.TemperatureSensor');
    check(!!hs, 'declares HumiditySensor');
    check(!ts, 'does not declare TemperatureSensor when only Humidity role selected');
    eq(hs?.properties?.supported?.[0]?.name, 'relativeHumidity', 'relativeHumidity supported');
    eq(hs?.properties?.retrievable, true, 'retrievable');
    eq(hs?.properties?.proactivelyReported, true, 'proactivelyReported');
  });

  await test('InfoOnlyAnalog ReportState (Temperature): value=22.5 with °C → CELSIUS', async () => {
    const env = infoOnlyAnalogEnv({
      value: 22.5, capabilities: ['TemperatureSensor'], format: '%.1f°C',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ioa3' },
      endpoint: { endpointId: 'alexa-ioa-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.TemperatureSensor');
    eq(prop?.value?.value, 22.5, 'value passes through');
    eq(prop?.value?.scale, 'CELSIUS', 'scale from format');
  });

  await test('InfoOnlyAnalog ReportState (Temperature): °F format → FAHRENHEIT', async () => {
    const env = infoOnlyAnalogEnv({
      value: 72.5, capabilities: ['TemperatureSensor'], format: '%.1f°F',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ioa4' },
      endpoint: { endpointId: 'alexa-ioa-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.TemperatureSensor');
    eq(prop?.value?.scale, 'FAHRENHEIT', 'scale from °F format');
  });

  await test('InfoOnlyAnalog ReportState (Humidity): value=45.7 → rounded plain number', async () => {
    // Alexa.HumiditySensor.relativeHumidity is a plain number, NOT wrapped
    // in {value: N} like temperature. Round defensively.
    const env = infoOnlyAnalogEnv({
      value: 45.7, capabilities: ['HumiditySensor'], format: '%.1f%%',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ioa5' },
      endpoint: { endpointId: 'alexa-ioa-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.HumiditySensor');
    eq(prop?.value, 46, 'rounded humidity');
    check(typeof prop?.value === 'number', 'plain number, not object');
  });

  await test('InfoOnlyAnalog ReportState cold cache omits property', async () => {
    const env = infoOnlyAnalogEnv({ value: null, capabilities: ['TemperatureSensor'] });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ioa6' },
      endpoint: { endpointId: 'alexa-ioa-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    check(!props.some((p) => p.namespace === 'Alexa.TemperatureSensor'),
      'no temperature when cache cold');
  });

  // ---- LightController (v1) -----------------------------------------------

  await test('parseSceneList: simple CSV with quoted names', () => {
    const out = parseSceneList('1="Szene 1",2="Szene 2",7="Mein Mix"');
    eq(out.length, 3, 'three entries');
    eq(out[0]?.id, 1, 'first id');
    eq(out[0]?.name, 'Szene 1', 'first name');
    eq(out[2]?.id, 7, 'third id (skipped 3-6)');
    eq(out[2]?.name, 'Mein Mix', 'third name');
  });

  await test('parseSceneList: tolerates escaped quotes', () => {
    const out = parseSceneList('1="Bob\\"s favorite",2="plain"');
    eq(out.length, 2, 'two entries');
    eq(out[0]?.name, 'Bob"s favorite', 'unescaped name');
    eq(out[1]?.name, 'plain', 'plain name');
  });

  await test('parseSceneList: malformed input returns []', () => {
    eq(parseSceneList('').length, 0, 'empty string');
    eq(parseSceneList(null).length, 0, 'null');
    eq(parseSceneList('not parseable').length, 0, 'gibberish');
  });

  await test('LightController v1 Discovery: cold cache → PowerController only', async () => {
    // sceneList not in state yet; Discovery should gracefully degrade.
    const env = lightControllerV1Env();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'lc1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    check(!!ep?.capabilities?.find((c) => c.interface === 'Alexa.PowerController'),
      'declares PowerController');
    check(!ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController'),
      'omits ModeController when scene list unknown');
  });

  await test('LightController v1 Discovery: scene list known → ModeController with Aloxberry.LightScene', async () => {
    const env = lightControllerV1Env({
      sceneListText: '1="Reading",2="Movie Night",5="Bright"',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'lc2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    check(!!mc, 'declares ModeController');
    eq(mc?.instance, 'Aloxberry.LightScene', 'instance distinct from v2 Aloxberry.LightMood');
    const modes = mc?.configuration?.supportedModes || [];
    eq(modes.length, 3, 'three scenes advertised');
    eq(modes[0]?.value, '1', 'first scene id');
  });

  await test('LightController v1 TurnOn → lowercase "on" command', async () => {
    const env = lightControllerV1Env();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'lc3' },
      endpoint: { endpointId: 'alexa-lc1-uuid' },
      payload: {},
    });
    const call = mock.calls.find((c) => c.kind === 'uuid');
    eq(call?.command, 'on', 'lowercase on per Loxone v17 docs');
  });

  await test('LightController v1 TurnOff → lowercase "off" command', async () => {
    const env = lightControllerV1Env();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOff', payloadVersion: '3', messageId: 'lc4' },
      endpoint: { endpointId: 'alexa-lc1-uuid' },
      payload: {},
    });
    const call = mock.calls.find((c) => c.kind === 'uuid');
    eq(call?.command, 'off', 'lowercase off per Loxone v17 docs');
  });

  await test('LightController v1 SetMode → raw scene number (no changeTo/ prefix)', async () => {
    const env = lightControllerV1Env({
      sceneListText: '1="Reading",5="Bright"',
    });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.LightScene',
        payloadVersion: '3', messageId: 'lc5',
      },
      endpoint: { endpointId: 'alexa-lc1-uuid' },
      payload: { mode: '5' },
    });
    const call = mock.calls.find((c) => c.kind === 'uuid');
    eq(call?.command, '5', 'raw scene number — no changeTo/ wrapping');
  });

  // Regression — P0 #4: an Alexa-supplied `mode` must not inject extra
  // path segments into jdev/sps/io/<uuid>/<cmd>. Both the v1 raw-scene
  // path and the default LightControllerV2 changeTo/<id> path now parse
  // + validate the id and reject anything non-numeric.
  await test('LightController v1 SetMode: path-traversal mode rejected, no Loxone call', async () => {
    const env = lightControllerV1Env({ sceneListText: '1="Reading",5="Bright"' });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.ModeController', name: 'SetMode',
                instance: 'Aloxberry.LightScene', payloadVersion: '3', messageId: 'lc-inj' },
      endpoint: { endpointId: 'alexa-lc1-uuid' },
      payload: { mode: '5/../../sys/reboot' },
    });
    eq(resp?.event?.payload?.type, 'INVALID_VALUE', 'rejected as INVALID_VALUE');
    eq(mock.calls.filter((c) => c.kind === 'uuid').length, 0, 'no Loxone command issued');
  });

  await test('LightControllerV2 default mood path: valid id → changeTo/<id>; injection rejected', async () => {
    const endpoints = [{
      endpointId: 'alexa-lcv2-uuid', friendlyName: 'Ceiling',
      displayCategories: ['LIGHT'], capabilities: ['PowerController', 'ModeController'],
      uuid: 'lcv2-uuid', msNo: 1,
    }];
    const structureCache = mockStructure([{ uuid: 'lcv2-uuid', type: 'LightControllerV2', states: {} }]);
    const stateCache = { getValue: () => undefined, getText: () => undefined };
    const env = { endpoints, structureCache, stateCache };

    const ok = await (newRouter(env.endpoints, env)).router.handle({
      header: { namespace: 'Alexa.ModeController', name: 'SetMode',
                instance: 'Aloxberry.LightMood', payloadVersion: '3', messageId: 'lcv2-ok' },
      endpoint: { endpointId: 'alexa-lcv2-uuid' },
      payload: { mode: '3' },
    });
    eq(ok?.event?.header?.name, 'Response', 'valid numeric mood accepted');

    const r2 = newRouter(env.endpoints, env);
    const bad = await r2.router.handle({
      header: { namespace: 'Alexa.ModeController', name: 'SetMode',
                instance: 'Aloxberry.LightMood', payloadVersion: '3', messageId: 'lcv2-inj' },
      endpoint: { endpointId: 'alexa-lcv2-uuid' },
      payload: { mode: '0/../../sys/reboot' },
    });
    eq(bad?.event?.payload?.type, 'INVALID_VALUE', 'injection rejected');
    eq(r2.mock.calls.filter((c) => c.kind === 'uuid').length, 0, 'no Loxone command issued');
  });

  await test('LightController v1 SetMode: scene 0 echoes powerState=OFF', async () => {
    const env = lightControllerV1Env({
      sceneListText: '0="All Off",1="Reading"',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.LightScene',
        payloadVersion: '3', messageId: 'lc6',
      },
      endpoint: { endpointId: 'alexa-lc1-uuid' },
      payload: { mode: '0' },
    });
    const power = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.PowerController');
    eq(power?.value, 'OFF', 'scene 0 → OFF');
  });

  await test('LightController v1 SetMode: non-zero scene echoes powerState=ON', async () => {
    const env = lightControllerV1Env({
      sceneListText: '1="Reading"',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.LightScene',
        payloadVersion: '3', messageId: 'lc7',
      },
      endpoint: { endpointId: 'alexa-lc1-uuid' },
      payload: { mode: '1' },
    });
    const power = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.PowerController');
    eq(power?.value, 'ON', 'scene 1 → ON');
  });

  await test('LightController v1 ReportState: activeScene=3 → ON + mode=3', async () => {
    const env = lightControllerV1Env({
      activeScene: 3, sceneListText: '1="Reading",3="Movie"',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'lc8' },
      endpoint: { endpointId: 'alexa-lc1-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    const power = props.find((p) => p.namespace === 'Alexa.PowerController');
    const mode  = props.find((p) => p.namespace === 'Alexa.ModeController');
    eq(power?.value, 'ON', 'non-zero scene → ON');
    eq(mode?.value, '3', 'mode = activeScene as string');
    eq(mode?.instance, 'Aloxberry.LightScene', 'correct instance');
  });

  await test('LightController v1 ReportState: activeScene=0 → OFF', async () => {
    const env = lightControllerV1Env({
      activeScene: 0, sceneListText: '0="All Off"',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'lc9' },
      endpoint: { endpointId: 'alexa-lc1-uuid' },
      payload: {},
    });
    const power = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.PowerController');
    eq(power?.value, 'OFF', 'scene 0 → OFF');
  });

  // ---- Sensor polarity inversion ------------------------------------------

  await test('PresenceDetector polarityInverted=true flips DETECTED → NOT_DETECTED', async () => {
    const env = presenceEnv({ active: 1, polarityInverted: true });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'pi1' },
      endpoint: { endpointId: 'alexa-pres-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.MotionSensor');
    eq(prop?.value, 'NOT_DETECTED', 'active=1 with inversion → NOT_DETECTED');
  });

  await test('PresenceDetector polarityInverted=true flips NOT_DETECTED → DETECTED', async () => {
    const env = presenceEnv({ active: 0, polarityInverted: true });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'pi2' },
      endpoint: { endpointId: 'alexa-pres-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.MotionSensor');
    eq(prop?.value, 'DETECTED', 'active=0 with inversion → DETECTED');
  });

  await test('WindowMonitor polarityInverted=true: all closed → NOT_DETECTED', async () => {
    const env = windowMonitorEnv({ windowStatesText: '1,1,1', polarityInverted: true });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'pi3' },
      endpoint: { endpointId: 'alexa-wm-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ContactSensor');
    eq(prop?.value, 'NOT_DETECTED', 'inverted: all closed → NOT_DETECTED (no detection)');
  });

  await test('WindowMonitor polarityInverted=true: one open → DETECTED', async () => {
    const env = windowMonitorEnv({ windowStatesText: '1,4,1', polarityInverted: true });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'pi4' },
      endpoint: { endpointId: 'alexa-wm-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ContactSensor');
    eq(prop?.value, 'DETECTED', 'inverted: any open → DETECTED ("Alexa detected an open window")');
  });

  await test('InfoOnlyDigital polarityInverted=true (Contact): active=1 → NOT_DETECTED', async () => {
    const env = infoOnlyDigitalEnv({
      active: 1, capabilities: ['ContactSensor'], polarityInverted: true,
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'pi5' },
      endpoint: { endpointId: 'alexa-iod-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ContactSensor');
    eq(prop?.value, 'NOT_DETECTED', 'reed switch active=1=door open → NOT_DETECTED');
  });

  await test('InfoOnlyDigital polarityInverted=true (Motion): active=0 → DETECTED', async () => {
    const env = infoOnlyDigitalEnv({
      active: 0, capabilities: ['MotionSensor'], polarityInverted: true,
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'pi6' },
      endpoint: { endpointId: 'alexa-iod-uuid' },
      payload: {},
    });
    const prop = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.MotionSensor');
    eq(prop?.value, 'DETECTED', 'inverted: active=0 → DETECTED');
  });

  // ---- Alexa.Semantics block on ContactSensor -----------------------------

  await test('ContactSensor Discovery includes Alexa.Semantics stateMappings', async () => {
    // Voice phrasing helper: tells Alexa that detectionState=DETECTED
    // means the door is CLOSED, and NOT_DETECTED means OPEN. Without this
    // Alexa would literally say "the door is detected" — semantically
    // wrong even when our wire mapping is correct.
    const env = windowMonitorEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'sem1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const cs = ep?.capabilities?.find((c) => c.interface === 'Alexa.ContactSensor');
    const mappings = cs?.semantics?.stateMappings || [];
    const closedMap = mappings.find((m) => m.states?.includes('Alexa.States.Closed'));
    const openMap   = mappings.find((m) => m.states?.includes('Alexa.States.Open'));
    check(!!closedMap, 'declares Alexa.States.Closed mapping');
    eq(closedMap?.value, 'DETECTED', 'Closed → DETECTED');
    check(!!openMap, 'declares Alexa.States.Open mapping');
    eq(openMap?.value, 'NOT_DETECTED', 'Open → NOT_DETECTED');
  });

  // ---- ACControl ----------------------------------------------------------

  await test('ACControl Discovery declares Power/Thermostat/TempSensor/Mode', async () => {
    const env = acControlEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ac1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const ifaces = (ep?.capabilities || []).map((c) => c.interface);
    check(ifaces.includes('Alexa.PowerController'),       'PowerController');
    check(ifaces.includes('Alexa.ThermostatController'),  'ThermostatController');
    check(ifaces.includes('Alexa.TemperatureSensor'),     'TemperatureSensor');
    check(ifaces.includes('Alexa.ModeController'),        'ModeController (fan)');
  });

  await test('ACControl Discovery: thermostatMode supports AUTO/HEAT/COOL only', async () => {
    const env = acControlEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ac2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const tc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ThermostatController');
    const modes = tc?.configuration?.supportedModes || [];
    check(modes.includes('AUTO'), 'AUTO');
    check(modes.includes('HEAT'), 'HEAT');
    check(modes.includes('COOL'), 'COOL');
    check(!modes.includes('OFF'), 'OFF deliberately omitted (handled via PowerController)');
  });

  await test('ACControl Discovery: fan ModeController has default slots when state cold', async () => {
    const env = acControlEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ac3' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    eq(mc?.instance, 'Aloxberry.AC.FanSpeed', 'fan-speed instance');
    eq(mc?.configuration?.supportedModes?.length, 8, '8 default fan slots (Off..Very High)');
    eq(mc?.configuration?.ordered, true, 'ordered: speeds have natural order');
  });

  await test('ACControl Discovery: fan slot names from fanspeeds state when present', async () => {
    const env = acControlEnv({ fanspeedsJson: '["Off","Auto","Quiet","Soft","Mid","Strong"]' });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'ac4' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    eq(mc?.configuration?.supportedModes?.length, 6, '6 custom-named slots');
    const firstName = mc?.configuration?.supportedModes?.[2]?.modeResources?.friendlyNames?.[0]?.value?.text;
    eq(firstName, 'Quiet', 'name from fanspeeds state');
  });

  await test('ACControl TurnOn → lowercase "on"', async () => {
    const env = acControlEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'ac5' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: {},
    });
    eq(mock.calls[0]?.command, 'on', 'lowercase on');
  });

  await test('ACControl TurnOff → lowercase "off"', async () => {
    const env = acControlEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOff', payloadVersion: '3', messageId: 'ac6' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: {},
    });
    eq(mock.calls[0]?.command, 'off', 'lowercase off');
  });

  await test('ACControl SetTargetTemperature → setTarget/<temp>', async () => {
    const env = acControlEnv({ minTemp: 16, maxTemp: 30 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature', payloadVersion: '3', messageId: 'ac7' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: { targetSetpoint: { value: 22.5, scale: 'CELSIUS' } },
    });
    eq(mock.calls[0]?.command, 'setTarget/22.5', 'setTarget with rounded temp');
  });

  await test('ACControl SetTargetTemperature clamps to device bounds', async () => {
    const env = acControlEnv({ minTemp: 18, maxTemp: 26 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetTargetTemperature', payloadVersion: '3', messageId: 'ac8' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: { targetSetpoint: { value: 35, scale: 'CELSIUS' } },
    });
    eq(mock.calls[0]?.command, 'setTarget/26', 'clamped to maxTemp');
  });

  await test('ACControl SetThermostatMode HEAT → setMode/2', async () => {
    const env = acControlEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetThermostatMode', payloadVersion: '3', messageId: 'ac9' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: { thermostatMode: { value: 'HEAT' } },
    });
    eq(mock.calls[0]?.command, 'setMode/2', 'HEAT → Loxone mode 2');
  });

  await test('ACControl SetThermostatMode COOL → setMode/3', async () => {
    const env = acControlEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetThermostatMode', payloadVersion: '3', messageId: 'ac10' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: { thermostatMode: { value: 'COOL' } },
    });
    eq(mock.calls[0]?.command, 'setMode/3', 'COOL → Loxone mode 3');
  });

  await test('ACControl SetThermostatMode AUTO → setMode/1', async () => {
    const env = acControlEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetThermostatMode', payloadVersion: '3', messageId: 'ac11' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: { thermostatMode: { value: 'AUTO' } },
    });
    eq(mock.calls[0]?.command, 'setMode/1', 'AUTO → Loxone mode 1');
  });

  await test('ACControl SetThermostatMode OFF → routes through "off" power command', async () => {
    // OFF is not a Loxone AC mode; should hit the PowerController off path
    // instead of setMode/0. The response echoes powerState=OFF.
    const env = acControlEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.ThermostatController', name: 'SetThermostatMode', payloadVersion: '3', messageId: 'ac12' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: { thermostatMode: { value: 'OFF' } },
    });
    eq(mock.calls[0]?.command, 'off', 'OFF mode routed to "off" power command');
    const power = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.PowerController');
    eq(power?.value, 'OFF', 'response echoes powerState=OFF');
  });

  await test('ACControl SetMode (fan) → setFan/<slot>', async () => {
    const env = acControlEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.AC.FanSpeed',
        payloadVersion: '3', messageId: 'ac13',
      },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: { mode: '5' },
    });
    eq(mock.calls[0]?.command, 'setFan/5', 'setFan with raw slot');
  });

  await test('ACControl ReportState aggregates all 5 properties', async () => {
    const env = acControlEnv({
      status: 1, mode: 2 /* Heat */, fan: 4,
      temperature: 23.5, targetTemperature: 21,
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ac14' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    const get = (ns, name) => props.find((p) => p.namespace === ns && p.name === name);
    eq(get('Alexa.PowerController', 'powerState')?.value, 'ON', 'status=1 → ON');
    eq(get('Alexa.ThermostatController', 'thermostatMode')?.value, 'HEAT', 'mode=2 → HEAT');
    eq(get('Alexa.ThermostatController', 'targetSetpoint')?.value?.value, 21, 'targetSetpoint');
    eq(get('Alexa.TemperatureSensor', 'temperature')?.value?.value, 23.5, 'temperature');
    eq(get('Alexa.ModeController', 'mode')?.value, '4', 'fan slot as string');
  });

  await test('ACControl ReportState in Dry mode omits thermostatMode (Alexa has no Dry)', async () => {
    const env = acControlEnv({
      status: 1, mode: 4 /* Dry */, temperature: 24, targetTemperature: 22,
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'ac15' },
      endpoint: { endpointId: 'alexa-ac-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    const tmode = props.find((p) => p.namespace === 'Alexa.ThermostatController' && p.name === 'thermostatMode');
    check(!tmode, 'thermostatMode omitted for Dry (Loxone mode 4)');
    // PowerController and other properties still emit normally.
    const power = props.find((p) => p.namespace === 'Alexa.PowerController');
    eq(power?.value, 'ON', 'powerState still emitted');
  });

  // ---- Ventilation --------------------------------------------------------

  await test('Ventilation Discovery declares Power/Range/Mode', async () => {
    const env = ventilationEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'v1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const ifaces = (ep?.capabilities || []).map((c) => c.interface);
    check(ifaces.includes('Alexa.PowerController'), 'PowerController');
    check(ifaces.includes('Alexa.RangeController'), 'RangeController');
    check(ifaces.includes('Alexa.ModeController'),  'ModeController');
  });

  await test('Ventilation Discovery: speed RangeController uses Aloxberry.Ventilation.Speed instance', async () => {
    const env = ventilationEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'v2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const rc = ep?.capabilities?.find((c) => c.interface === 'Alexa.RangeController');
    eq(rc?.instance, 'Aloxberry.Ventilation.Speed', 'speed instance');
    eq(rc?.configuration?.unitOfMeasure, 'Alexa.Unit.Percent', 'percent unit');
    const presets = rc?.configuration?.presets || [];
    check(presets.length >= 3, 'has presets (low/med/high)');
  });

  await test('Ventilation Discovery: mode list from details.modes', async () => {
    const env = ventilationEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'v3' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    eq(mc?.instance, 'Aloxberry.Ventilation.Mode', 'vent mode instance');
    const modes = mc?.configuration?.supportedModes || [];
    eq(modes.length, 3, 'three modes from details.modes');
    eq(modes[0]?.value, '0', 'first mode id');
    eq(modes[0]?.modeResources?.friendlyNames?.[0]?.value?.text, 'Heat Exchanger', 'first mode name');
  });

  await test('Ventilation TurnOn → setTimer/0 (cancel manual, return to auto)', async () => {
    const env = ventilationEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'v4' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    eq(mock.calls[0]?.command, 'setTimer/0', 'cancel timer = return to auto');
  });

  await test('Ventilation TurnOff → manual timer at speed 0 for configured hours', async () => {
    // With ventilationOverrideHours=24, command should be setTimer/86400/0/<currentMode>/-1
    const env = ventilationEnv({ mode: 1, ventilationOverrideHours: 24 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOff', payloadVersion: '3', messageId: 'v5' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    eq(mock.calls[0]?.command, 'setTimer/86400/0/1/-1',
      '24h manual override at speed=0, mode preserved');
  });

  await test('Ventilation TurnOff respects per-device hours setting', async () => {
    // 2h override should produce 7200 second interval.
    const env = ventilationEnv({ mode: 0, ventilationOverrideHours: 2 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOff', payloadVersion: '3', messageId: 'v6' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    eq(mock.calls[0]?.command, 'setTimer/7200/0/0/-1', '2h override');
  });

  await test('Ventilation TurnOff with cold mode cache falls back to mode 0', async () => {
    const env = ventilationEnv({ mode: null, ventilationOverrideHours: 24 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: { namespace: 'Alexa.PowerController', name: 'TurnOff', payloadVersion: '3', messageId: 'v7' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    eq(mock.calls[0]?.command, 'setTimer/86400/0/0/-1', 'mode 0 fallback');
  });

  await test('Ventilation SetRangeValue (speed) preserves current mode', async () => {
    const env = ventilationEnv({ speed: 25, mode: 2, ventilationOverrideHours: 24 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.RangeController', name: 'SetRangeValue',
        instance: 'Aloxberry.Ventilation.Speed',
        payloadVersion: '3', messageId: 'v8',
      },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: { rangeValue: 75 },
    });
    eq(mock.calls[0]?.command, 'setTimer/86400/75/2/-1', 'speed=75, mode=2 preserved');
  });

  await test('Ventilation SetRangeValue clamps to 0..100', async () => {
    const env = ventilationEnv({ mode: 0 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.RangeController', name: 'SetRangeValue',
        instance: 'Aloxberry.Ventilation.Speed',
        payloadVersion: '3', messageId: 'v9',
      },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: { rangeValue: 150 },
    });
    eq(mock.calls[0]?.command, 'setTimer/86400/100/0/-1', 'clamped to 100');
  });

  await test('Ventilation SetMode (mode change) preserves current speed', async () => {
    const env = ventilationEnv({ speed: 40, mode: 0 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.Ventilation.Mode',
        payloadVersion: '3', messageId: 'v10',
      },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: { mode: '1' },
    });
    eq(mock.calls[0]?.command, 'setTimer/86400/40/1/-1', 'mode=1, speed=40 preserved');
  });

  await test('Ventilation SetMode with cold speed cache falls back to 50', async () => {
    const env = ventilationEnv({ speed: null, mode: 0 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.Ventilation.Mode',
        payloadVersion: '3', messageId: 'v11',
      },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: { mode: '2' },
    });
    eq(mock.calls[0]?.command, 'setTimer/86400/50/2/-1', 'speed=50 fallback');
  });

  await test('Ventilation ReportState: speed=0 + manual timer → OFF', async () => {
    const env = ventilationEnv({ speed: 0, mode: 0, activeTimerProfile: -1 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'v12' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    const power = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.PowerController');
    eq(power?.value, 'OFF', 'manual+speed=0 → OFF');
  });

  await test('Ventilation ReportState: speed=0 + no timer → ON (auto idle)', async () => {
    // -2 = no timer active. Block is in automatic logic, just running at
    // speed 0 because conditions don't demand more. Still ON semantically.
    const env = ventilationEnv({ speed: 0, mode: 0, activeTimerProfile: -2 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'v13' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    const power = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.PowerController');
    eq(power?.value, 'ON', 'auto idle = ON');
  });

  await test('Ventilation ReportState: speed=60 + manual timer → ON', async () => {
    const env = ventilationEnv({ speed: 60, mode: 1, activeTimerProfile: -1 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'v14' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    const get = (ns) => props.find((p) => p.namespace === ns);
    eq(get('Alexa.PowerController')?.value, 'ON', 'manual+speed>0 = ON');
    eq(get('Alexa.RangeController')?.value, 60, 'speed = 60');
    eq(get('Alexa.ModeController')?.value, '1', 'mode = 1');
  });

  await test('Ventilation ReportState (TemperatureSensor opt-in): emits temp when enabled', async () => {
    const env = ventilationEnv({
      capabilities: ['PowerController', 'RangeController', 'ModeController', 'TemperatureSensor'],
      temperatureIndoor: 21.5,
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'v15' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    const temp = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.TemperatureSensor');
    eq(temp?.value?.value, 21.5, 'indoor temp emitted');
  });

  await test('Ventilation ReportState (HumiditySensor opt-in): emits humidity rounded', async () => {
    const env = ventilationEnv({
      capabilities: ['PowerController', 'RangeController', 'ModeController', 'HumiditySensor'],
      humidityIndoor: 47.6,
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'v16' },
      endpoint: { endpointId: 'alexa-vent-uuid' },
      payload: {},
    });
    const hum = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.HumiditySensor');
    eq(hum?.value, 48, 'humidity rounded');
  });

  // ---- Radio --------------------------------------------------------------

  await test('Radio Discovery: ModeController with slot list from details.outputs', async () => {
    const env = radioEnv({ outputs: { 1: 'Comfort', 2: 'Eco', 5: 'Frost' } });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'r1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    eq(mc?.instance, 'Aloxberry.Radio', 'Radio instance');
    const modes = mc?.configuration?.supportedModes || [];
    eq(modes.length, 3, 'three configured slots');
    eq(modes[0]?.value, '1', 'first slot id');
    eq(modes[0]?.modeResources?.friendlyNames?.[0]?.value?.text, 'Comfort', 'first slot name');
    eq(modes[2]?.value, '5', 'gap-skipping preserved');
  });

  await test('Radio Discovery: allOff string surfaces id=0 as the first slot', async () => {
    const env = radioEnv({
      outputs: { 1: 'Mode A', 2: 'Mode B' },
      allOff: 'Off',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'r2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    const modes = mc?.configuration?.supportedModes || [];
    eq(modes.length, 3, 'three slots: All Off + 2 outputs');
    eq(modes[0]?.value, '0', 'All Off at id=0, listed first');
    eq(modes[0]?.modeResources?.friendlyNames?.[0]?.value?.text, 'Off', 'All Off label from details');
  });

  await test('Radio SetMode → raw ID', async () => {
    const env = radioEnv({ outputs: { 1: 'A', 2: 'B', 3: 'C' } });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.Radio',
        payloadVersion: '3', messageId: 'r3',
      },
      endpoint: { endpointId: 'alexa-radio-uuid' },
      payload: { mode: '2' },
    });
    eq(mock.calls[0]?.command, '2', 'raw output ID on the wire');
  });

  await test('Radio SetMode value=0 → "reset" (not raw 0)', async () => {
    // Per v17 Structure File p.112: "0 cannot be selected directly, only
    // via `reset`". Sending "0" would silently no-op on the Miniserver.
    const env = radioEnv({ outputs: { 1: 'A' }, allOff: 'Off' });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.Radio',
        payloadVersion: '3', messageId: 'r4',
      },
      endpoint: { endpointId: 'alexa-radio-uuid' },
      payload: { mode: '0' },
    });
    eq(mock.calls[0]?.command, 'reset', 'id=0 maps to reset verb');
  });

  await test('Radio ReportState: activeOutput → ModeController.mode (as string)', async () => {
    const env = radioEnv({ outputs: { 1: 'A', 2: 'B' }, activeOutput: 2 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'r5' },
      endpoint: { endpointId: 'alexa-radio-uuid' },
      payload: {},
    });
    const mode = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ModeController');
    eq(mode?.value, '2', 'active id as string');
    eq(mode?.instance, 'Aloxberry.Radio', 'correct instance');
  });

  await test('Radio ReportState cold cache omits mode', async () => {
    const env = radioEnv({ outputs: { 1: 'A' }, activeOutput: null });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'r6' },
      endpoint: { endpointId: 'alexa-radio-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    check(!props.some((p) => p.namespace === 'Alexa.ModeController'),
      'no mode property when cache cold');
  });

  // ---- Binary-sensor ModeController (custom labels) -----------------------

  await test('InfoOnlyDigital with ModeController role: Discovery uses custom labels', async () => {
    const env = infoOnlyDigitalEnv({
      capabilities: ['ModeController'],
      modeLabelActive: 'Full',
      modeLabelInactive: 'Empty',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'bs1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    eq(mc?.instance, 'Aloxberry.BinarySensor', 'binary-sensor instance');
    const modes = mc?.configuration?.supportedModes || [];
    eq(modes.length, 2, 'two slots');
    eq(modes[0]?.value, '0', 'inactive at slot 0');
    eq(modes[0]?.modeResources?.friendlyNames?.[0]?.value?.text, 'Empty', 'custom inactive label');
    eq(modes[1]?.value, '1', 'active at slot 1');
    eq(modes[1]?.modeResources?.friendlyNames?.[0]?.value?.text, 'Full', 'custom active label');
  });

  await test('Binary-sensor ModeController: blank labels fall back to Active/Inactive', async () => {
    const env = presenceEnv({
      capabilities: ['ModeController'],
      modeLabelActive: '',
      modeLabelInactive: '',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'bs2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    const modes = mc?.configuration?.supportedModes || [];
    eq(modes[0]?.modeResources?.friendlyNames?.[0]?.value?.text, 'Inactive', 'fallback inactive');
    eq(modes[1]?.modeResources?.friendlyNames?.[0]?.value?.text, 'Active', 'fallback active');
  });

  await test('Binary-sensor ModeController SetMode rejected with INVALID_VALUE', async () => {
    // ModeController on a read-only sensor doesn't accept writes —
    // there's no physical way to "set" a motion-detector's state.
    const env = presenceEnv({ capabilities: ['ModeController'] });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.BinarySensor',
        payloadVersion: '3', messageId: 'bs3',
      },
      endpoint: { endpointId: 'alexa-pres-uuid' },
      payload: { mode: '1' },
    });
    eq(mock.calls.length, 0, 'no Loxone command sent');
    eq(resp?.event?.payload?.type, 'INVALID_VALUE', 'rejected');
  });

  await test('Binary-sensor ModeController ReportState: active=1 + polarity off → mode "1"', async () => {
    const env = presenceEnv({
      active: 1, polarityInverted: false,
      capabilities: ['ModeController'],
      modeLabelActive: 'Occupied',
      modeLabelInactive: 'Vacant',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'bs4' },
      endpoint: { endpointId: 'alexa-pres-uuid' },
      payload: {},
    });
    const mode = (resp?.context?.properties || []).find(
      (p) => p.namespace === 'Alexa.ModeController' && p.instance === 'Aloxberry.BinarySensor'
    );
    eq(mode?.value, '1', 'active=1 → mode "1"');
  });

  await test('Binary-sensor ModeController ReportState: respects polarity inversion', async () => {
    // active=1 with polarity ON → polarized = NOT_DETECTED → mode "0".
    const env = presenceEnv({
      active: 1, polarityInverted: true,
      capabilities: ['ModeController'],
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'bs5' },
      endpoint: { endpointId: 'alexa-pres-uuid' },
      payload: {},
    });
    const mode = (resp?.context?.properties || []).find(
      (p) => p.namespace === 'Alexa.ModeController' && p.instance === 'Aloxberry.BinarySensor'
    );
    eq(mode?.value, '0', 'inverted: active=1 → mode "0"');
  });

  await test('InfoOnlyDigital with BOTH ContactSensor AND ModeController: Discovery declares both', async () => {
    // Confirms the new ModeController role coexists with the existing
    // ContactSensor/MotionSensor primary role. State-reporter will emit
    // both on each event; the cap filter keeps each device's chosen set.
    const env = infoOnlyDigitalEnv({
      capabilities: ['ContactSensor', 'ModeController'],
      modeLabelActive: 'Wet',
      modeLabelInactive: 'Dry',
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'bs6' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const ifaces = (ep?.capabilities || []).map((c) => c.interface);
    check(ifaces.includes('Alexa.ContactSensor'), 'ContactSensor present');
    check(ifaces.includes('Alexa.ModeController'), 'ModeController present');
    const mc = ep.capabilities.find((c) => c.interface === 'Alexa.ModeController');
    eq(mc?.instance, 'Aloxberry.BinarySensor', 'binary-sensor instance');
  });

  await test('WindowMonitor with ModeController role: Discovery + ReportState', async () => {
    const env = windowMonitorEnv({
      windowStatesText: '1,1,1',  // all closed
      capabilities: ['ModeController'],
      modeLabelActive: 'Secure',
      modeLabelInactive: 'Window open',
      polarityInverted: false,
    });
    const { router } = newRouter(env.endpoints, env);
    const respDisc = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'bs7' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const mc = respDisc?.event?.payload?.endpoints?.[0]?.capabilities?.find(
      (c) => c.interface === 'Alexa.ModeController'
    );
    eq(mc?.configuration?.supportedModes?.[1]?.modeResources?.friendlyNames?.[0]?.value?.text,
      'Secure', 'WindowMonitor active label');
    const respRs = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'bs8' },
      endpoint: { endpointId: 'alexa-wm-uuid' },
      payload: {},
    });
    const mode = (respRs?.context?.properties || []).find(
      (p) => p.namespace === 'Alexa.ModeController' && p.instance === 'Aloxberry.BinarySensor'
    );
    eq(mode?.value, '1', 'all closed = DETECTED (no inversion) → mode "1"');
  });

  // ---- Sequential ---------------------------------------------------------

  await test('Sequential Discovery: ModeController with synthesized None slot at id=0', async () => {
    const env = sequentialEnv({
      sequences: [{ id: 4, name: 'Gustav' }, { id: 8, name: 'Karl' }],
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 's1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const mc = ep?.capabilities?.find((c) => c.interface === 'Alexa.ModeController');
    eq(mc?.instance, 'Aloxberry.Sequence', 'Sequential instance');
    const modes = mc?.configuration?.supportedModes || [];
    eq(modes.length, 3, 'two sequences + None slot');
    eq(modes[0]?.value, '0', 'None at id=0 listed first');
    eq(modes[0]?.modeResources?.friendlyNames?.[0]?.value?.text, 'None', 'None label');
    eq(modes[1]?.value, '4', 'first real sequence id');
    eq(modes[1]?.modeResources?.friendlyNames?.[0]?.value?.text, 'Gustav', 'first sequence name');
  });

  await test('Sequential SetMode → triggerSequence/<id>', async () => {
    const env = sequentialEnv({
      sequences: [{ id: 4, name: 'Christmas' }, { id: 7, name: 'Halloween' }],
    });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.Sequence',
        payloadVersion: '3', messageId: 's2',
      },
      endpoint: { endpointId: 'alexa-seq-uuid' },
      payload: { mode: '7' },
    });
    eq(mock.calls[0]?.command, 'triggerSequence/7', 'triggerSequence with raw id');
  });

  await test('Sequential SetMode value=0 → triggerSequence/0 (stops any running)', async () => {
    // Unlike Radio (which uses `reset` for id=0), Sequential uses the
    // same triggerSequence verb with 0 as the stop sentinel.
    const env = sequentialEnv();
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.ModeController', name: 'SetMode',
        instance: 'Aloxberry.Sequence',
        payloadVersion: '3', messageId: 's3',
      },
      endpoint: { endpointId: 'alexa-seq-uuid' },
      payload: { mode: '0' },
    });
    eq(mock.calls[0]?.command, 'triggerSequence/0', 'id=0 stops via same verb');
  });

  await test('Sequential ReportState: activeSequence → ModeController.mode (as string)', async () => {
    const env = sequentialEnv({
      sequences: [{ id: 4, name: 'A' }],
      activeSequence: 4,
    });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 's4' },
      endpoint: { endpointId: 'alexa-seq-uuid' },
      payload: {},
    });
    const mode = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.ModeController');
    eq(mode?.value, '4', 'active sequence id as string');
    eq(mode?.instance, 'Aloxberry.Sequence', 'correct instance');
  });

  await test('Sequential ReportState cold cache omits mode', async () => {
    const env = sequentialEnv({ activeSequence: null });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 's5' },
      endpoint: { endpointId: 'alexa-seq-uuid' },
      payload: {},
    });
    const props = resp?.context?.properties || [];
    check(!props.some((p) => p.namespace === 'Alexa.ModeController'),
      'no mode when cache cold');
  });

  // ---- ValueSelector ------------------------------------------------------

  await test('ValueSelector Discovery: bounds from live state', async () => {
    const env = valueSelectorEnv({ min: 10, max: 50, step: 2 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'vs1' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const rc = ep?.capabilities?.find((c) => c.interface === 'Alexa.RangeController');
    eq(rc?.instance, 'Aloxberry.ValueSelector', 'ValueSelector instance');
    eq(rc?.configuration?.supportedRange?.minimumValue, 10, 'min from state');
    eq(rc?.configuration?.supportedRange?.maximumValue, 50, 'max from state');
    eq(rc?.configuration?.supportedRange?.precision, 2, 'step from state');
  });

  await test('ValueSelector Discovery: cold cache falls back to 0..100/1', async () => {
    const env = valueSelectorEnv();
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa.Discovery', name: 'Discover', payloadVersion: '3', messageId: 'vs2' },
      payload: { scope: { type: 'BearerToken', token: 't' } },
    });
    const ep = resp?.event?.payload?.endpoints?.[0];
    const rc = ep?.capabilities?.find((c) => c.interface === 'Alexa.RangeController');
    eq(rc?.configuration?.supportedRange?.minimumValue, 0, 'default min');
    eq(rc?.configuration?.supportedRange?.maximumValue, 100, 'default max');
  });

  await test('ValueSelector SetRangeValue → raw value (within bounds)', async () => {
    const env = valueSelectorEnv({ min: 0, max: 100, step: 1 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.RangeController', name: 'SetRangeValue',
        instance: 'Aloxberry.ValueSelector',
        payloadVersion: '3', messageId: 'vs3',
      },
      endpoint: { endpointId: 'alexa-vs-uuid' },
      payload: { rangeValue: 42 },
    });
    eq(mock.calls[0]?.command, '42', 'raw value on wire');
  });

  await test('ValueSelector SetRangeValue snaps to step', async () => {
    // step=5, min=0, max=100, request=43 → snap to 45 (45 - 0)/5 = 9 step.
    const env = valueSelectorEnv({ min: 0, max: 100, step: 5 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.RangeController', name: 'SetRangeValue',
        instance: 'Aloxberry.ValueSelector',
        payloadVersion: '3', messageId: 'vs4',
      },
      endpoint: { endpointId: 'alexa-vs-uuid' },
      payload: { rangeValue: 43 },
    });
    eq(mock.calls[0]?.command, '45', 'snapped to nearest step boundary');
  });

  await test('ValueSelector SetRangeValue clamps to bounds', async () => {
    const env = valueSelectorEnv({ min: 10, max: 20, step: 1 });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.RangeController', name: 'SetRangeValue',
        instance: 'Aloxberry.ValueSelector',
        payloadVersion: '3', messageId: 'vs5',
      },
      endpoint: { endpointId: 'alexa-vs-uuid' },
      payload: { rangeValue: 100 },
    });
    eq(mock.calls[0]?.command, '20', 'clamped to max');
  });

  await test('ValueSelector AdjustRangeValue on increase-only: positive delta OK', async () => {
    const env = valueSelectorEnv({ value: 30, min: 0, max: 100, step: 1, increaseOnly: true });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.RangeController', name: 'AdjustRangeValue',
        instance: 'Aloxberry.ValueSelector',
        payloadVersion: '3', messageId: 'vs6',
      },
      endpoint: { endpointId: 'alexa-vs-uuid' },
      payload: { rangeValueDelta: 10 },
    });
    eq(mock.calls[0]?.command, '40', '30 + 10 → 40');
  });

  await test('ValueSelector AdjustRangeValue on increase-only: negative delta rejected', async () => {
    const env = valueSelectorEnv({ value: 30, min: 0, max: 100, step: 1, increaseOnly: true });
    const { router, mock } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: {
        namespace: 'Alexa.RangeController', name: 'AdjustRangeValue',
        instance: 'Aloxberry.ValueSelector',
        payloadVersion: '3', messageId: 'vs7',
      },
      endpoint: { endpointId: 'alexa-vs-uuid' },
      payload: { rangeValueDelta: -5 },
    });
    eq(mock.calls.length, 0, 'no Loxone call');
    eq(resp?.event?.payload?.type, 'INVALID_VALUE', 'rejected with INVALID_VALUE');
  });

  await test('ValueSelector AdjustRangeValue allows negative when NOT increase-only', async () => {
    const env = valueSelectorEnv({ value: 30, min: 0, max: 100, step: 1, increaseOnly: false });
    const { router, mock } = newRouter(env.endpoints, env);
    await router.handle({
      header: {
        namespace: 'Alexa.RangeController', name: 'AdjustRangeValue',
        instance: 'Aloxberry.ValueSelector',
        payloadVersion: '3', messageId: 'vs8',
      },
      endpoint: { endpointId: 'alexa-vs-uuid' },
      payload: { rangeValueDelta: -5 },
    });
    eq(mock.calls[0]?.command, '25', '30 - 5 → 25');
  });

  await test('ValueSelector ReportState reads current value', async () => {
    const env = valueSelectorEnv({ value: 17, min: 0, max: 50, step: 1 });
    const { router } = newRouter(env.endpoints, env);
    const resp = await router.handle({
      header: { namespace: 'Alexa', name: 'ReportState', payloadVersion: '3', messageId: 'vs9' },
      endpoint: { endpointId: 'alexa-vs-uuid' },
      payload: {},
    });
    const rv = (resp?.context?.properties || []).find((p) => p.namespace === 'Alexa.RangeController');
    eq(rv?.value, 17, 'current value emitted');
    eq(rv?.instance, 'Aloxberry.ValueSelector', 'correct instance');
  });

  // ---- IMPLEMENTED_CAPABILITIES self-consistency --------------------------
  //
  // The picker UI in devices.html reads catalogue.implementedCapabilities to
  // decide which capability checkboxes are toggleable. If a capability
  // appears in IMPLEMENTED_CAPABILITIES but the dispatch can't actually
  // serve any of its directives, users would enable a checkbox that does
  // nothing — exactly the failure mode this whole refactor exists to prevent.
  // This test fails fast if the list grows out of sync with reality.

  await test('IMPLEMENTED_CAPABILITIES has a real handler for every entry', async () => {
    const { router } = newRouter();
    // For each declared capability, send one syntactically valid directive
    // in its namespace. A real handler returns either a Response/StateReport
    // or a domain error (ENDPOINT_UNREACHABLE, INVALID_DIRECTIVE about a
    // missing endpoint, etc.) — anything but INVALID_DIRECTIVE with the
    // "not implemented" wording, which is what the default branch returns.
    const probes = {
      PowerController:            { ns: 'Alexa.PowerController',            name: 'TurnOn' },
      BrightnessController:       { ns: 'Alexa.BrightnessController',       name: 'SetBrightness',          payload: { brightness: 50 } },
      ColorController:            { ns: 'Alexa.ColorController',            name: 'SetColor',               payload: { color: { hue: 120, saturation: 1, brightness: 1 } } },
      ColorTemperatureController: { ns: 'Alexa.ColorTemperatureController', name: 'SetColorTemperature',    payload: { colorTemperatureInKelvin: 4000 } },
      ModeController:             { ns: 'Alexa.ModeController',             name: 'SetMode',                payload: { mode: '1' } },
      RangeController:            { ns: 'Alexa.RangeController',            name: 'SetRangeValue',          payload: { rangeValue: 50 } },
      SceneController:            { ns: 'Alexa.SceneController',            name: 'Activate',               payload: { cause: { type: 'VOICE_INTERACTION' } } },
      ThermostatController:       { ns: 'Alexa.ThermostatController',       name: 'SetTargetTemperature',   payload: { targetSetpoint: { value: 22, scale: 'CELSIUS' } } },
      Speaker:                    { ns: 'Alexa.Speaker',                    name: 'SetVolume',              payload: { volume: 30 } },
      PlaybackController:         { ns: 'Alexa.PlaybackController',         name: 'Play' },
      ToggleController:           { ns: 'Alexa.ToggleController',           name: 'TurnOn', instance: 'Aloxberry.Audio.Shuffle' },
      // Read-only capabilities: no directives. The ReportState path
      // exercises them, but this probe surface doesn't.
      TemperatureSensor:          null,
      PlaybackStateReporter:      null,
      MotionSensor:               null,
      ContactSensor:              null,
      HumiditySensor:             null,
    };
    for (const cap of IMPLEMENTED_CAPABILITIES) {
      const probe = probes[cap];
      // Read-only capabilities (TemperatureSensor) opt out by mapping to
      // null — they have no directives, only ReportState contributions.
      if (probe === null) continue;
      check(!!probe, `probe defined for ${cap}`);
      if (!probe) continue;
      const resp = await router.handle({
        header: {
          namespace: probe.ns, name: probe.name,
          payloadVersion: '3', messageId: 'mic-' + cap,
          instance: probe.instance || 'Aloxberry.Blind.Position',
        },
        endpoint: { endpointId: 'alexa-pluginTest' },
        payload: probe.payload || {},
      });
      // Acceptable: handled (any response) OR a domain error that doesn't
      // claim "not implemented". The only forbidden outcome is the default
      // branch's INVALID_DIRECTIVE with a "not implemented" message.
      const errType = resp?.event?.payload?.type;
      const errMsg  = resp?.event?.payload?.message || '';
      const ranThroughDefault = errType === 'INVALID_DIRECTIVE' && /is not implemented/.test(errMsg);
      check(!ranThroughDefault, `dispatch has a handler for ${cap}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
