'use strict';

// Phase 4 outbound: builds + signs + dispatches Alexa ChangeReports when
// Loxone state changes happen on a control the user has exposed.
//
// Pipeline:
//
//   MiniserverStateCache emits 'change' for stateUuid X
//     ↓
//   Reverse-index lookup:  stateUuid → { controlUuid, stateName, type }
//     ↓                    (built from structure cache + devices.json)
//   Check the device is enabled in devices.json
//     ↓
//   Map (controlType + stateName + value) → Alexa property list
//     ↓
//   Build ChangeReport envelope (Alexa schema v3) WITHOUT the LWA bearer
//   token — the Lambda fills that in per recipient (one daemon event fans
//   out to N Alexa accounts, each with their own access-token)
//     ↓
//   Sign the canonical JSON body with the daemon's skillSecret
//     ↓
//   bridgeClient.sendReport({ timestamp, signature, payload })
//
// What this module does NOT do:
//   - Talk to the Lambda directly (bridge-client owns transport)
//   - Track LWA tokens (the Lambda does that per user)
//   - Filter by Alexa user (we sign once; the Lambda fans out per row)
//   - Implement state mapping for every Loxone type — v1 covers
//     Switch / TimedSwitch only (PowerController.powerState). The rest
//     plug in here as their daemon-side mappings land in later phases.

const { createHmac, randomUUID } = require('node:crypto');
const {
  parseActiveMoods, parseColorState,
  BLIND_TYPES, RANGE_INSTANCE_BLINDS, RANGE_INSTANCE_SLIDER,
  rangeBoundsFor, mirrorInRange,
  thermostatScaleFor, alexaModeFromLoxone,
  polarize,
  MODE_INSTANCE_LIGHT_SCENE, OFF_SCENE_ID,
  MODE_INSTANCE_AC_FAN, alexaModeFromAC,
  RANGE_INSTANCE_VENT_SPEED, MODE_INSTANCE_VENT_MODE,
  VENT_TIMER_PROFILE_MANUAL,
  MODE_INSTANCE_RADIO, RANGE_INSTANCE_VALUE_SELECTOR,
  MODE_INSTANCE_SEQUENCE,
  MODE_INSTANCE_BINARY_SENSOR,
  AUDIO_TYPES, TOGGLE_INSTANCE_SHUFFLE,
  MODE_INSTANCE_REPEAT, MODE_INSTANCE_SOURCE,
  ALEXA_BY_REPEAT, alexaPlaybackStateFromLoxone,
  dimmerToBrightness,
} = require('./directive-router');
const { endpointIdFor } = require('./devices-config');

// Loxone's hard-coded "All Off" mood ID — matches OFF_MOOD_ID in
// directive-router.js. Kept distinct to avoid importing through a circular
// dep (state-reporter ← directive-router is the only direction).
const LIGHTCTRL_OFF_MOOD_ID = 778;
const MODE_INSTANCE = 'Aloxberry.LightMood';

// Map Alexa namespace → device-config capability string. Used in the
// per-capability filter so a device-config that disabled e.g.
// ColorController doesn't get ChangeReports for it.
const ALEXA_NAMESPACE_TO_CAPABILITY = {
  'Alexa.PowerController':            'PowerController',
  'Alexa.ModeController':             'ModeController',
  'Alexa.BrightnessController':       'BrightnessController',
  'Alexa.ColorController':            'ColorController',
  'Alexa.ColorTemperatureController': 'ColorTemperatureController',
  'Alexa.RangeController':            'RangeController',
  'Alexa.ThermostatController':       'ThermostatController',
  'Alexa.TemperatureSensor':          'TemperatureSensor',
  'Alexa.Speaker':                    'Speaker',
  'Alexa.PlaybackStateReporter':      'PlaybackStateReporter',
  'Alexa.ToggleController':           'ToggleController',
  'Alexa.MotionSensor':               'MotionSensor',
  'Alexa.ContactSensor':              'ContactSensor',
  'Alexa.HumiditySensor':             'HumiditySensor',
};

class StateReporter {
  constructor({ structure, devicesConfig, stateCache, bridgeClient, identity, log }) {
    this.structure    = structure;
    this.devicesConfig = devicesConfig;
    this.stateCache   = stateCache;
    this.bridgeClient = bridgeClient;
    this.identity     = identity;
    this.log          = log.child({ component: 'state-reporter' });

    // stateUuid → { controlUuid, stateName, type }
    // Rebuilt whenever devices.json changes (chokidar watch in DevicesConfig).
    this._reverseIndex = new Map();

    this._onCacheChange  = this._onCacheChange.bind(this);
    this._onDevicesChange = () => this._buildIndex();

    // Aggregate liveness counters. We deliberately do NOT log per cache
    // event (fires on every Miniserver state push — far too chatty). Instead
    // a once-a-minute summary preserves the only thing that log was for:
    // confirming the WS event stream is still alive after a reload. A window
    // reading `total=0` right after a reload is the hang smoking gun.
    this._cacheStats = { total: 0, matched: 0 };
    this._cacheStatsTimer = null;
  }

  start() {
    this._buildIndex();
    this.stateCache.on('change', this._onCacheChange);
    this.devicesConfig.on('change', this._onDevicesChange);
    // Once-a-minute aggregate heartbeat (DEBUG — operator opts in when
    // diagnosing). unref'd so it can't keep a dying process alive. Always
    // emitted, including zero windows: a sudden `total=0` is exactly the
    // post-reload-silence signal we need, and one line/minute is negligible.
    this._cacheStatsTimer = setInterval(() => {
      const { total, matched } = this._cacheStats;
      this._cacheStats.total = 0;
      this._cacheStats.matched = 0;
      this.log.debug(
        { total, matched, windowSec: 60 },
        'state-reporter: cache-event heartbeat (events seen / matched an exposed device)',
      );
    }, 60_000);
    this._cacheStatsTimer.unref();
    this.log.info({ indexedStates: this._reverseIndex.size }, 'state reporter started');
  }

  stop() {
    this.stateCache.off('change', this._onCacheChange);
    this.devicesConfig.off('change', this._onDevicesChange);
    if (this._cacheStatsTimer) {
      clearInterval(this._cacheStatsTimer);
      this._cacheStatsTimer = null;
    }
  }

  // Compute the FULL CURRENT STATE of an endpoint as an Alexa property
  // array. Iterates every (stateName, stateUuid) in the control, reads the
  // current cached value/text, and pushes it through the same
  // _mapToProperties mapper the live path uses. The result is the same
  // shape Alexa would build for a StateReport response — which is
  // exactly what belongs in ChangeReport `context.properties`.
  //
  // Used by both the live ChangeReport path (where it populates context
  // while change.properties carries only what triggered the event) and
  // the snapshot path (where it's both context and change).
  //
  // Dedupes by (namespace, instance, name): if two Loxone state UUIDs
  // happen to map to the same Alexa property, last-write-wins, matching
  // the structure.json iteration order (deterministic).
  _currentPropertiesForDevice(device, control) {
    if (!control || !control.states) return [];
    const collected = [];
    for (const [stateName, stateUuid] of Object.entries(control.states)) {
      if (typeof stateUuid !== 'string') continue;
      const valueEntry = this.stateCache.getValue(stateUuid);
      const textEntry  = this.stateCache.getText(stateUuid);
      let mapped = [];
      try {
        if (valueEntry && Number.isFinite(valueEntry.value)) {
          mapped = this._mapToProperties({
            control, device, stateName, kind: 'value', value: valueEntry.value,
          });
        } else if (textEntry && typeof textEntry.text === 'string') {
          mapped = this._mapToProperties({
            control, device, stateName, kind: 'text', text: textEntry.text,
          });
        }
      } catch (err) {
        // One malformed state must not abort the whole device snapshot
        // (which would leave Alexa with no context and, pre-guard, could
        // unwind out of _onCacheChange into the WS parser and kill the
        // daemon). Log the exact (type, stateName) and skip just this state.
        this.log.error(
          { uuid: device.uuid, type: control.type, stateName,
            err: err && err.stack || String(err) },
          'state-reporter: _mapToProperties threw — state skipped',
        );
        mapped = [];
      }
      for (const p of mapped) collected.push(p);
    }
    // Per-capability opt-out — same filter the live path uses.
    const filtered = collected.filter((p) => {
      const cap = ALEXA_NAMESPACE_TO_CAPABILITY[p.namespace];
      if (!cap) return true;
      return device.capabilities?.includes(cap);
    });
    // Dedupe by (namespace, instance, name); last occurrence wins.
    const byKey = new Map();
    for (const p of filtered) {
      const key = `${p.namespace}|${p.instance || ''}|${p.name}`;
      byKey.set(key, p);
    }
    return Array.from(byKey.values());
  }

  // Dispatch a "snapshot" ChangeReport for every enabled endpoint, using
  // whatever's currently in the state-cache. Designed to bootstrap Alexa's
  // view of properties that rarely change (thermostatMode, source slot,
  // etc.) — those would otherwise never be ChangeReport'd, leaving Alexa
  // with an incomplete model and degraded tile rendering.
  //
  // Per-device design: each endpoint produces ONE ChangeReport containing
  // all currently-knowable properties at once (propertyCount = N). This is
  // intentionally different from the per-event path (which fires one tight
  // report per state change). For the snapshot, we want to push everything
  // atomically; for live updates, we want to minimize noise.
  //
  // Returns { dispatched, total, skipped } so callers can confirm work.
  async dispatchSnapshot() {
    let dispatched = 0;
    let skipped = 0;
    const devices = this.devicesConfig.list();
    const total = devices.length;
    for (const device of devices) {
      if (!device.enabled) { skipped++; continue; }
      const control = this.structure.getControl(device.uuid);
      if (!control) { skipped++; continue; }

      let properties;
      try {
        properties = this._currentPropertiesForDevice(device, control);
      } catch (err) {
        // Defence in depth: _currentPropertiesForDevice already guards per
        // state, but never let one device abort the whole snapshot sweep.
        this.log.error(
          { uuid: device.uuid, type: control.type,
            err: err && err.stack || String(err) },
          'state-reporter: snapshot for device threw — device skipped',
        );
        skipped++;
        continue;
      }
      if (properties.length === 0) { skipped++; continue; }

      // For a snapshot, change.properties carries the full state and
      // context.properties is empty (per Alexa spec: context = OTHER
      // properties not in change). Alexa accepts this shape for atomic
      // state syncs.
      const changeReport = this._buildChangeReport({
        device,
        properties,
        cause: 'APP_INTERACTION',
        contextProperties: [],
      });
      this._dispatch(changeReport);
      dispatched++;
    }
    this.log.info({ dispatched, skipped, total }, 'snapshot dispatch complete');
    return { dispatched, skipped, total };
  }

  // Build the reverse index: for every exposed device, look up the
  // control's states map in the structure cache and register each
  // state-UUID. Only enabled devices contribute, so dropping a device in
  // the picker silently stops its reports.
  _buildIndex() {
    this.log.debug('state-reporter: _buildIndex enter');
    const index = new Map();
    const devices = this.devicesConfig.list();
    let registered = 0;

    for (const device of devices) {
      if (!device.enabled) continue;
      const control = this.structure.getControl(device.uuid);
      if (!control) {
        this.log.debug({ uuid: device.uuid }, 'device has no matching control in structure');
        continue;
      }
      if (!control.states) continue;

      for (const [stateName, stateUuid] of Object.entries(control.states)) {
        if (typeof stateUuid !== 'string' || !stateUuid) continue;
        index.set(stateUuid, {
          controlUuid: device.uuid,
          stateName,
          type: control.type,
        });
        registered++;
      }
    }
    this._reverseIndex = index;
    // INFO log at every (re)build so the operator can confirm: which
    // devices the daemon is watching, the Loxone control type behind each,
    // the picker-selected Alexa capabilities, and the state UUIDs the
    // reverse index ended up keyed by. Particularly useful when an Alexa
    // directive arrives and we want to know which Loxone state should
    // change as a result — the log shows whether we even have the right
    // state UUID subscribed.
    this.log.info(
      {
        deviceCount:  devices.length,
        stateUuids:   index.size,
        devices: devices.map((d) => {
          const c = this.structure.getControl(d.uuid);
          return {
            uuid:    d.uuid,
            name:    d.friendlyName,
            enabled: d.enabled,
            type:    c?.type || null,
            caps:    d.capabilities || [],
            states:  c?.states || null,
            // `details` carries the per-type config the resolvers need
            // (Radio `outputs`, Ventilation `modes`, Sequential
            // `sequences`, Slider min/max/step, °C/°F `format`, …).
            // Included here so this dump can confirm the parser actually
            // captured it — its absence was the "Radio doesn't appear in
            // Alexa" root cause and was undiagnosable from the old dump.
            details: c?.details || null,
          };
        }),
      },
      'state-reporter: device index rebuilt',
    );
  }

  _onCacheChange(ev) {
    // Liveness accounting only — NO per-event log (this fires on every
    // Miniserver state push). The once-a-minute heartbeat in start() emits
    // the aggregate; absence/zero of that summary after a reload is the
    // hang signal.
    this._cacheStats.total++;
    try {
      this._onCacheChangeInner(ev);
    } catch (err) {
      // This handler runs as a stateCache 'change' EventEmitter listener.
      // An uncaught throw here propagates out of emit() into the WebSocket
      // message parser that fed the event — which is exactly the silent
      // "daemon stopped responding, no error logged" signature. Contain it.
      this.log.error(
        { stateUuid: ev?.uuid, kind: ev?.kind, err: err && err.stack || String(err) },
        'state-reporter: _onCacheChange threw — event dropped, daemon kept alive',
      );
    }
  }

  _onCacheChangeInner(ev) {
    const indexed = this._reverseIndex.get(ev.uuid);
    if (!indexed) return; // state UUID isn't for an exposed device
    this._cacheStats.matched++; // counted only when it hits an exposed device

    // Debug log so an operator can correlate a Loxone state event to a
    // specific exposed device — useful when debugging "why did the
    // ChangeReport go to the wrong endpointId" scenarios where multiple
    // devices may share a state UUID through Loxone's parent/sub-control
    // structure. Debug-level: per-event diagnostic, off in normal ops.
    this.log.debug(
      {
        stateUuid:   ev.uuid,
        kind:        ev.kind,
        controlUuid: indexed.controlUuid,
        stateName:   indexed.stateName,
        type:        indexed.type,
        value:       ev.kind === 'value' ? ev.value : undefined,
        text:        ev.kind === 'text'  ? ev.text  : undefined,
      },
      'state change → control lookup',
    );

    // Re-check the device is still enabled (devices.json could've toggled
    // between buildIndex and this event).
    const device = this.devicesConfig.list().find((d) => d.uuid === indexed.controlUuid);
    if (!device || !device.enabled) return;

    // Only handle the (kind, type, stateName) combinations our mapping table
    // knows about. Pass the event's `value` for value-events and `text` for
    // text-events; the mapper picks the right field per case. RangeController
    // mappings also need the full control + device, since the bounds (for
    // Slider) and axis flag live there.
    const control = this.structure.getControl(indexed.controlUuid);
    const properties = this._mapToProperties({
      control,
      device,
      stateName: indexed.stateName,
      kind:      ev.kind,
      value:     ev.value,
      text:      ev.text,
    });
    if (properties.length === 0) return;

    // Honour per-capability opt-out: a device-config that drops e.g.
    // 'ColorController' from its capabilities array should not trigger
    // color-related ChangeReports (the Alexa side never declared it).
    const filtered = properties.filter((p) => {
      const cap = ALEXA_NAMESPACE_TO_CAPABILITY[p.namespace];
      if (!cap) return true;
      return device.capabilities?.includes(cap);
    });
    if (filtered.length === 0) return;

    // Build the full current state so Alexa receives complete context. The
    // changed property goes in change.properties; the other current
    // properties (snapshot) go in context.properties. Without this,
    // Alexa's specialized tile renderers (thermostat especially) reject
    // the endpoint as having incomplete state and fall back to a degraded
    // generic tile.
    const fullState = this._currentPropertiesForDevice(device, control);
    const changedKeys = new Set(
      filtered.map((p) => `${p.namespace}|${p.instance || ''}|${p.name}`)
    );
    const contextProperties = fullState.filter(
      (p) => !changedKeys.has(`${p.namespace}|${p.instance || ''}|${p.name}`)
    );

    const changeReport = this._buildChangeReport({
      device,
      properties: filtered,
      contextProperties,
    });
    this._dispatch(changeReport);
  }

  // Translate (Loxone control type + state name + value/text) → Alexa
  // property list. v1 covers Switch / TimedSwitch (PowerController) and
  // LightControllerV2 (PowerController + ModeController). Each new mapping
  // is one case below; the surrounding plumbing stays untouched.
  _mapToProperties({ control, device, stateName, kind, value, text }) {
    const type = control?.type;
    if (kind === 'value' && (type === 'Switch' || type === 'TimedSwitch') && stateName === 'active') {
      return [{
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        // Loxone Switch sends 0/1 (sometimes other numerics for TimedSwitch
        // mid-countdown). Treat strictly-zero as OFF; everything else ON.
        value: Number(value) === 0 ? 'OFF' : 'ON',
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // Dimmer: `position` (native [min,max]) → PowerController + Brightness.
    // Mirrors the directive-router pull path exactly (shared dimmerToBrightness
    // helper + identical OFF-iff-position-0 rule), so the proactive push and
    // the post-Discovery pull can never disagree. min/max are read from the
    // cache when present (Structure File V17 p.59 — configurable per control),
    // defaulting to 0/100. A `min`/`max`-only change is config-time and rare,
    // so we re-report on `position` events (same scope as the sibling types).
    if (kind === 'value' && type === 'Dimmer' && stateName === 'position') {
      const pos = Number(value);
      if (!Number.isFinite(pos)) return [];
      const readNum = (su) => {
        const e = su ? this.stateCache.getValue(su) : null;
        return (e && Number.isFinite(e.value)) ? e.value : undefined;
      };
      const min = readNum(control?.states?.min);
      const max = readNum(control?.states?.max);
      const now = new Date().toISOString();
      return [
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: pos === 0 ? 'OFF' : 'ON',
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.BrightnessController',
          name: 'brightness',
          value: dimmerToBrightness(pos, min, max),
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
      ];
    }
    if (kind === 'text' && type === 'ColorPickerV2' && stateName === 'color') {
      const parsed = parseColorState(text);
      if (!parsed) return [];
      const now = new Date().toISOString();
      const properties = [
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: parsed.brightness > 0 ? 'ON' : 'OFF',
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.BrightnessController',
          name: 'brightness',
          value: parsed.brightness,
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
      ];
      // ColorController / ColorTemperatureController are mutually exclusive
      // on the Loxone state — emit only the property matching the current
      // mode. Alexa keeps the last-known value for the other property until
      // we next change to that mode.
      if (parsed.mode === 'hsv') {
        properties.push({
          namespace: 'Alexa.ColorController',
          name: 'color',
          value: {
            hue:        parsed.hue,
            saturation: parsed.saturation / 100,
            brightness: parsed.brightness / 100,
          },
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        });
      } else if (parsed.mode === 'temp') {
        properties.push({
          namespace: 'Alexa.ColorTemperatureController',
          name: 'colorTemperatureInKelvin',
          value: parsed.kelvin,
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        });
      }
      return properties;
    }
    // RangeController: blind-shaped (Jalousie / Window / Gate) on `position`,
    // or Slider on `value`. The scale + axis flag come from the same helpers
    // the directive-router uses, so reads and writes can't disagree.
    if (kind === 'value' && BLIND_TYPES.has(type) && stateName === 'position') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      // 0..1 Loxone position → 0..100 raw scale; rounding tames transient
      // float jitter during motion (0.4999 → 0.5001).
      const raw = Math.max(0, Math.min(100, Math.round(n * 100)));
      const bounds = rangeBoundsFor(control);
      const axisInverted = !!device?.rangeAxisInverted;
      const rangeValue = axisInverted ? mirrorInRange(raw, bounds) : raw;
      return [{
        namespace: 'Alexa.RangeController',
        instance:  RANGE_INSTANCE_BLINDS,
        name:      'rangeValue',
        value:     rangeValue,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'Slider' && stateName === 'value') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      const bounds = rangeBoundsFor(control);
      const axisInverted = !!device?.rangeAxisInverted;
      const rangeValue = axisInverted ? mirrorInRange(n, bounds) : n;
      return [{
        namespace: 'Alexa.RangeController',
        instance:  RANGE_INSTANCE_SLIDER,
        name:      'rangeValue',
        value:     rangeValue,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // IRoomControllerV2 thermostat states. Three separate state UUIDs
    // (tempActual / tempTarget / operatingMode) map to four Alexa
    // properties spread across two capabilities — each event handled
    // independently so an isolated state change emits a tight ChangeReport
    // rather than batching unrelated readings.
    if (kind === 'value' && type === 'IRoomControllerV2' && stateName === 'tempActual') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.TemperatureSensor',
        name: 'temperature',
        value: { value: n, scale: thermostatScaleFor(control) },
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'IRoomControllerV2' && stateName === 'tempTarget') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.ThermostatController',
        name: 'targetSetpoint',
        value: { value: n, scale: thermostatScaleFor(control) },
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'IRoomControllerV2' && stateName === 'operatingMode') {
      const mode = alexaModeFromLoxone(Number(value));
      if (!mode) return [];
      return [{
        namespace: 'Alexa.ThermostatController',
        name: 'thermostatMode',
        value: mode,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // ACControl mappings. Five independent state UUIDs feeding five Alexa
    // properties spread across four capabilities (PowerController,
    // ThermostatController × 2, TemperatureSensor, ModeController). Each
    // event emits one narrow ChangeReport so the live path mirrors the
    // ReportState resolvers exactly.
    if (kind === 'value' && type === 'ACControl' && stateName === 'status') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        value: n !== 0 ? 'ON' : 'OFF',
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'ACControl' && stateName === 'temperature') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.TemperatureSensor',
        name: 'temperature',
        value: { value: n, scale: thermostatScaleFor(control) },
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'ACControl' && stateName === 'targetTemperature') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.ThermostatController',
        name: 'targetSetpoint',
        value: { value: n, scale: thermostatScaleFor(control) },
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'ACControl' && stateName === 'mode') {
      // Returns null for Dry (4) / Fan (5) — omit the property in those
      // cases so Alexa doesn't see a misleading mode value.
      const mode = alexaModeFromAC(Number(value));
      if (!mode) return [];
      return [{
        namespace: 'Alexa.ThermostatController',
        name: 'thermostatMode',
        value: mode,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'ACControl' && stateName === 'fan') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.ModeController',
        instance:  MODE_INSTANCE_AC_FAN,
        name:      'mode',
        value:     String(Math.trunc(n)),
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // Ventilation mappings. PowerController is derived from the (timer-
    // profile, speed) tuple — we look up the OTHER state from the cache
    // when one half changes, so a single speed event can still emit a
    // correct power state. Same idea on the inverse direction.
    if (kind === 'value' && type === 'Ventilation' && stateName === 'speed') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      const speed = Math.max(0, Math.min(100, Math.round(n)));
      const now = new Date().toISOString();
      const props = [{
        namespace: 'Alexa.RangeController',
        instance:  RANGE_INSTANCE_VENT_SPEED,
        name:      'rangeValue',
        value:     speed,
        timeOfSample: now,
        uncertaintyInMilliseconds: 0,
      }];
      // Read activeTimerProfile from cache to make the combined power-state
      // determination. Without it, we'd either lie ("speed=0 = OFF" misses
      // the auto-quiet case) or skip ("never emit power on speed change"
      // means OFF→ON transitions go unreported until profile also changes).
      const tpUuid = control?.states?.activeTimerProfile;
      const tpEntry = tpUuid ? this.stateCache.getValue(tpUuid) : null;
      const tp = (tpEntry && Number.isFinite(tpEntry.value))
        ? Math.trunc(tpEntry.value) : null;
      // OFF iff (manual timer AND speed = 0). Anything else = ON.
      const offByManualZero = tp === VENT_TIMER_PROFILE_MANUAL && speed === 0;
      props.push({
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        value: offByManualZero ? 'OFF' : 'ON',
        timeOfSample: now,
        uncertaintyInMilliseconds: 0,
      });
      return props;
    }
    if (kind === 'value' && type === 'Ventilation' && stateName === 'activeTimerProfile') {
      const tp = Number(value);
      if (!Number.isFinite(tp)) return [];
      // Mirror of the speed-event logic: re-derive powerState from the
      // (timer-profile, speed) tuple. We don't emit RangeController here
      // because the rangeValue hasn't actually changed; only the implied
      // power state has.
      const speedUuid = control?.states?.speed;
      const speedEntry = speedUuid ? this.stateCache.getValue(speedUuid) : null;
      const speed = (speedEntry && Number.isFinite(speedEntry.value))
        ? Math.max(0, Math.min(100, Math.round(speedEntry.value))) : 0;
      const offByManualZero = Math.trunc(tp) === VENT_TIMER_PROFILE_MANUAL && speed === 0;
      return [{
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        value: offByManualZero ? 'OFF' : 'ON',
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'Ventilation' && stateName === 'mode') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.ModeController',
        instance:  MODE_INSTANCE_VENT_MODE,
        name:      'mode',
        value:     String(Math.trunc(n)),
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'Ventilation' && stateName === 'temperatureIndoor') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.TemperatureSensor',
        name: 'temperature',
        value: { value: n, scale: thermostatScaleFor(control) },
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // Radio: activeOutput → ModeController.mode. ID 0 is the "All Off"
    // pseudo-slot Discovery surfaces when details.allOff is configured.
    if (kind === 'value' && type === 'Radio' && stateName === 'activeOutput') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.ModeController',
        instance:  MODE_INSTANCE_RADIO,
        name:      'mode',
        value:     String(Math.trunc(n)),
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // Sequential: activeSequence → ModeController.mode. ID 0 = no
    // sequence running (matches the synthesized "None" slot in Discovery).
    if (kind === 'value' && type === 'Sequential' && stateName === 'activeSequence') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.ModeController',
        instance:  MODE_INSTANCE_SEQUENCE,
        name:      'mode',
        value:     String(Math.trunc(n)),
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // ValueSelector: `value` state → RangeController.rangeValue. No
    // axis inversion, no scaling — the value is already in native bounds.
    // Bounds changes (min/max/step state changes) don't emit a property
    // here because Alexa has no way to update supportedRange on a live
    // endpoint short of a fresh Discovery; we rely on the user re-running
    // "discover devices" if their bounds change.
    if (kind === 'value' && type === 'ValueSelector' && stateName === 'value') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.RangeController',
        instance:  RANGE_INSTANCE_VALUE_SELECTOR,
        name:      'rangeValue',
        value:     n,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && type === 'Ventilation' && stateName === 'humidityIndoor') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.HumiditySensor',
        name: 'relativeHumidity',
        value: Math.round(n),
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // AudioZone / AudioZoneV2 mappings — six independent state UUIDs each
    // emit their own narrow ChangeReport rather than batching, so motion
    // (volume slide, track skip, etc.) doesn't produce churn beyond the
    // properties that actually changed.
    if (kind === 'value' && AUDIO_TYPES.has(type) && stateName === 'volume') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.Speaker',
        name: 'volume',
        value: Math.max(0, Math.min(100, Math.round(n))),
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && AUDIO_TYPES.has(type) && stateName === 'power') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      // Emit BOTH PowerController.powerState AND Speaker.muted from the
      // same Loxone state. They're two views of the same underlying fact
      // (this speaker is silenced) but Alexa wants them advertised under
      // their respective interfaces. The capability filter in
      // _onCacheChange drops whichever isn't enabled per-device, so
      // emitting both is harmless and lets users pick either capability.
      const ts = new Date().toISOString();
      return [
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: n === 0 ? 'OFF' : 'ON',
          timeOfSample: ts,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.Speaker',
          name: 'muted',
          value: n === 0,
          timeOfSample: ts,
          uncertaintyInMilliseconds: 0,
        },
      ];
    }
    if (kind === 'value' && AUDIO_TYPES.has(type) && stateName === 'playState') {
      const state = alexaPlaybackStateFromLoxone(value);
      if (!state) return [];
      return [{
        namespace: 'Alexa.PlaybackStateReporter',
        name: 'playbackState',
        value: { state },
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && AUDIO_TYPES.has(type) && stateName === 'shuffle') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      return [{
        namespace: 'Alexa.ToggleController',
        instance:  TOGGLE_INSTANCE_SHUFFLE,
        name:      'toggleState',
        value:     n === 0 ? 'OFF' : 'ON',
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && AUDIO_TYPES.has(type) && stateName === 'repeat') {
      const mode = ALEXA_BY_REPEAT[Number(value)];
      if (!mode) return [];
      return [{
        namespace: 'Alexa.ModeController',
        instance:  MODE_INSTANCE_REPEAT,
        name:      'mode',
        value:     mode,
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    if (kind === 'value' && AUDIO_TYPES.has(type) && stateName === 'source') {
      const slot = Number(value);
      if (!Number.isFinite(slot)) return [];
      return [{
        namespace: 'Alexa.ModeController',
        instance:  MODE_INSTANCE_SOURCE,
        name:      'mode',
        value:     String(slot),
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 0,
      }];
    }
    // PresenceDetector.active → Alexa.MotionSensor.detectionState +
    // (when ModeController role enabled) Alexa.ModeController.mode "0"/"1".
    // Both emit on every event; the capability filter drops whichever
    // role the device didn't enable. Polarity inversion applies to both
    // — same wire reading underneath.
    if (kind === 'value' && type === 'PresenceDetector' && stateName === 'active') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      const polarized = polarize(
        n !== 0 ? 'DETECTED' : 'NOT_DETECTED',
        device.sensorPolarityInverted,
      );
      const now = new Date().toISOString();
      return [
        {
          namespace: 'Alexa.MotionSensor',
          name: 'detectionState',
          value: polarized,
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.ModeController',
          instance:  MODE_INSTANCE_BINARY_SENSOR,
          name:      'mode',
          value:     polarized === 'DETECTED' ? '1' : '0',
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
      ];
    }
    // InfoOnlyDigital.active → emit MotionSensor + ContactSensor +
    // ModeController detection. Downstream capability filter (line ~132)
    // drops whichever role(s) the user didn't enable. This lets one
    // mapping serve every configuration without per-device branching here.
    // Polarity inversion applies to all three emitted properties (same
    // setting controls all — there's only one wire reading underneath).
    if (kind === 'value' && type === 'InfoOnlyDigital' && stateName === 'active') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      const state = polarize(
        n !== 0 ? 'DETECTED' : 'NOT_DETECTED',
        device.sensorPolarityInverted,
      );
      const now = new Date().toISOString();
      return [
        {
          namespace: 'Alexa.MotionSensor',
          name: 'detectionState',
          value: state,
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.ContactSensor',
          name: 'detectionState',
          value: state,
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.ModeController',
          instance:  MODE_INSTANCE_BINARY_SENSOR,
          name:      'mode',
          value:     state === 'DETECTED' ? '1' : '0',
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
      ];
    }
    // InfoOnlyAnalog.value → emit BOTH TemperatureSensor.temperature
    // ({value, scale}) and HumiditySensor.relativeHumidity (plain number).
    // Same dual-emit pattern; capability filter drops the unused one.
    // °C/°F is inferred from control.details.format via thermostatScaleFor
    // — the regex matches any format string carrying °C or °F regardless
    // of whether the control is a thermostat or a plain analog reading.
    if (kind === 'value' && type === 'InfoOnlyAnalog' && stateName === 'value') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      const scale = thermostatScaleFor(control);
      const now = new Date().toISOString();
      return [
        {
          namespace: 'Alexa.TemperatureSensor',
          name: 'temperature',
          value: { value: n, scale },
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.HumiditySensor',
          name: 'relativeHumidity',
          value: Math.round(n),
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
      ];
    }
    // WindowMonitor.windowStates → Alexa.ContactSensor.detectionState +
    // (when ModeController role enabled) Alexa.ModeController.mode.
    // Aggregate semantic: all closed (every entry = 1) → DETECTED;
    // anything else (tilted=2, open=4, unknown=0, etc.) → NOT_DETECTED.
    // Polarity inversion (default on) flips this so "any window open"
    // surfaces as DETECTED instead of "all closed" — usually the more
    // useful Alexa routine trigger.
    if (kind === 'text' && type === 'WindowMonitor' && stateName === 'windowStates') {
      if (typeof text !== 'string' || !text.length) return [];
      const states = text.split(',').map((s) => Number.parseInt(s.trim(), 10));
      const allClosed = states.length > 0
        && states.every((n) => Number.isFinite(n) && n === 1);
      const raw = allClosed ? 'DETECTED' : 'NOT_DETECTED';
      const polarized = polarize(raw, device.sensorPolarityInverted);
      const now = new Date().toISOString();
      return [
        {
          namespace: 'Alexa.ContactSensor',
          name: 'detectionState',
          value: polarized,
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.ModeController',
          instance:  MODE_INSTANCE_BINARY_SENSOR,
          name:      'mode',
          value:     polarized === 'DETECTED' ? '1' : '0',
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
      ];
    }
    // LightController (v1): activeScene is a numeric value state, not text.
    // Emits BOTH ModeController.mode (under Aloxberry.LightScene) and
    // PowerController.powerState (OFF iff scene 0 — Loxone's hard-coded
    // "all off"). Same dual-emit pattern as v2; only the instance string
    // and the OFF sentinel differ.
    if (kind === 'value' && type === 'LightController' && stateName === 'activeScene') {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      const id = Math.trunc(n);
      const now = new Date().toISOString();
      return [
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: id === OFF_SCENE_ID ? 'OFF' : 'ON',
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.ModeController',
          instance: MODE_INSTANCE_LIGHT_SCENE,
          name: 'mode',
          value: String(id),
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        },
      ];
    }
    if (kind === 'text' && type === 'LightControllerV2' && stateName === 'activeMoods') {
      const ids = parseActiveMoods(text);
      const now = new Date().toISOString();
      // PowerController: OFF iff the only active mood is All-Off. An empty
      // activeMoods (rare; happens before initial state sync) also reads as
      // OFF — fail-closed.
      const isOff = ids.length === 0 || (ids.length === 1 && ids[0] === LIGHTCTRL_OFF_MOOD_ID);
      const properties = [{
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        value: isOff ? 'OFF' : 'ON',
        timeOfSample: now,
        uncertaintyInMilliseconds: 0,
      }];
      // ModeController: report the *first* active mood as the canonical one.
      // Loxone supports additive moods but Alexa's ModeController is single-
      // valued; first-wins matches the "primary mood" semantics most users
      // expect from voice phrasings.
      if (ids.length > 0) {
        properties.push({
          namespace: 'Alexa.ModeController',
          instance: MODE_INSTANCE,
          name: 'mode',
          value: String(ids[0]),
          timeOfSample: now,
          uncertaintyInMilliseconds: 0,
        });
      }
      return properties;
    }
    return [];
  }

  _buildChangeReport({ device, properties, cause = 'PHYSICAL_INTERACTION', contextProperties = [] }) {
    return {
      // context.properties carries the full current state of OTHER (not in
      // change.properties) retrievable properties of the endpoint. Required
      // by Alexa for ChangeReports — specialized tile renderers
      // (thermostat especially) depend on this to assemble the device
      // view; an empty context downgrades the tile to a generic renderer
      // even when change.properties is correct.
      context: { properties: contextProperties },
      event: {
        header: {
          namespace: 'Alexa',
          name: 'ChangeReport',
          messageId: randomUUID(),
          payloadVersion: '3',
        },
        endpoint: {
          // The bearer token is filled in per-recipient by the Lambda; we
          // send a placeholder so the schema is well-formed when logged.
          scope: { type: 'BearerToken', token: 'LAMBDA_FILLS_IN' },
          // endpointIdFor strips Loxone's '/' (sub-control separator)
          // since Alexa's endpointId regex disallows it. Must match
          // exactly what devices-config.toEndpoints() declared at
          // Discovery time, otherwise Alexa ignores the ChangeReport.
          endpointId: endpointIdFor(device.uuid),
        },
        payload: {
          change: {
            // Cause attribution:
            //   PHYSICAL_INTERACTION (default) — wall-switch or other
            //     non-Alexa origin. The live path uses this because Loxone
            //     doesn't tell us who touched a state.
            //   APP_INTERACTION — the snapshot path uses this to signal
            //     "this is a daemon-initiated sync, not a real change."
            cause: { type: cause },
            properties,
          },
        },
      },
    };
  }

  _dispatch(changeReport) {
    const timestamp = Date.now();
    // Sign the canonical-string form so the Lambda can verify byte-for-byte.
    // The bridge ships this string opaquely; nothing between us and the
    // Lambda re-serializes it.
    const body = JSON.stringify({
      bridgeUserId: this.identity.userId,
      changeReport,
    });
    const signature = createHmac('sha256', this.identity.skillSecretBytes)
      .update(`${timestamp}\n${body}`)
      .digest('hex');

    this.log.debug(
      { endpointId: changeReport.event?.endpoint?.endpointId, bytes: body.length },
      'state-reporter: _dispatch → bridgeClient.sendReport',
    );
    const sent = this.bridgeClient.sendReport({
      timestamp,
      signature,
      payload: body,
    });
    this.log.debug({ sent }, 'state-reporter: _dispatch ← sendReport returned');
    if (sent) {
      this.log.info(
        {
          endpointId: changeReport.event.endpoint.endpointId,
          propertyCount: changeReport.event.payload.change.properties.length,
        },
        'ChangeReport dispatched',
      );
    }
  }
}

module.exports = { StateReporter };
