'use strict';

// LoxAPP3.json fetcher, parser, and cache.
//
// Responsibilities:
//   - Spawn bin/lox-getstructure.pl to fetch the raw JSON from the
//     Miniserver (via LoxBerry::IO's token cache).
//   - Persist the raw JSON to disk (data/loxapp3.json) so the CGI's
//     "Devices" picker keeps working when the Miniserver is offline.
//   - Parse the structure into a flat catalogue of controls (parent + sub)
//     with rooms, categories, type, and an "Alexa-compatible" flag.
//   - Expose the catalogue + lookup helpers to the rest of the daemon.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const EventEmitter = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

const PERL_HELPER = path.join(__dirname, '..', 'lox-getstructure.pl');

// Loxone control types we know how to expose to Alexa. The picker hides
// everything else by default ("Hide Alexa-incompatible types" filter), but
// users can still see them by toggling that filter off.
//
// Each entry pairs the Loxone type with its default Alexa displayCategory
// and the set of capabilities we *can* offer (some greyed-out in v1 until
// the daemon learns the corresponding directives in Phase 3).
//
// v1 daemon-side implementation status:
//   PowerController            — implemented (TurnOn/TurnOff via lox-control.pl)
//   SceneController            — implemented (Activate via lowercase `pulse`)
//   ModeController             — implemented (LightControllerV2 moods)
//   BrightnessController       — implemented (ColorPickerV2, parent control)
//   ColorController            — implemented (ColorPickerV2)
//   ColorTemperatureController — implemented (ColorPickerV2)
//   RangeController            — implemented (Jalousie position)
//   ThermostatController       — Phase 4
//
// The picker UI queries /catalogue.implementedCapabilities for the
// authoritative list — see local-http.js. This comment is a quick reference
// for source-readers; the authoritative source is IMPLEMENTED_CAPABILITIES
// in directive-router.js.
// Per-control-type entries. `category` is the default Alexa displayCategory;
// `allowedCategories` (optional) narrows the picker's dropdown to the
// categories that make sense for this control type. Without
// allowedCategories the picker shows the full CATEGORIES list. The daemon's
// VALID_CATEGORIES (in devices-config.js) is the universal whitelist —
// hand-edited devices.json can use anything in there; only the picker UI
// applies the per-type narrowing.
const TYPE_MAP = Object.freeze({
  Switch: {
    category: 'SWITCH',
    capabilities: ['PowerController'],
    // A Switch can drive almost any on/off load — keep the dropdown wide
    // so users can pick the right Alexa icon and routine integration.
    // (DOORBELL deliberately excluded: Alexa expects DOORBELL endpoints to
    // emit Alexa.DoorbellEventSource events, not just on/off — assigning it
    // to a PowerController endpoint just renders a doorbell icon with no
    // working Routine trigger.)
    allowedCategories: ['SWITCH', 'OUTLET', 'SMARTPLUG', 'FAN', 'LIGHT',
                        'DOOR', 'AIR_PURIFIER', 'OTHER'],
  },
  TimedSwitch: {
    category: 'SWITCH',
    capabilities: ['PowerController'],
    // SceneController is an opt-in ALTERNATIVE to PowerController. A Loxone
    // TimedSwitch is fundamentally a momentary `pulse` trigger, which maps
    // perfectly onto an Alexa Scene: stateless and infinitely re-triggerable,
    // unlike a PowerController switch (which Alexa de-duplicates once it
    // believes the device is on — so a comfort-switch toggle can't be
    // re-fired). The daemon needs no special-casing: _handleSceneActivate
    // already sends `pulse` for any uuid endpoint. Pair it with the
    // SCENE_TRIGGER / ACTIVITY_TRIGGER category so Alexa renders it as a Scene.
    optionalCapabilities: ['SceneController'],
    // Stateful switch vs. stateless trigger are two incompatible renderings of
    // the same control — the picker enforces "exactly one active".
    exclusiveCapabilities: ['PowerController', 'SceneController'],
    allowedCategories: ['SWITCH', 'OUTLET', 'SMARTPLUG', 'FAN', 'LIGHT',
                        'DOOR', 'SCENE_TRIGGER', 'ACTIVITY_TRIGGER', 'OTHER'],
    // Picker-only metadata: which Alexa categories belong with each member of
    // the exclusive-capability group. The picker keeps the capability and the
    // category in lockstep (pick a scene category → SceneController, and vice
    // versa) so a user can never produce a nonsensical pair like a
    // SceneController on a SWITCH tile. OTHER is intentionally in BOTH lists
    // (a deliberate catch-all), so selecting it never force-flips the
    // capability. The union of these lists equals allowedCategories. The
    // daemon ignores this field — it's consumed only by devices.html.
    capabilityCategories: {
      PowerController: ['SWITCH', 'OUTLET', 'SMARTPLUG', 'FAN', 'LIGHT', 'DOOR', 'OTHER'],
      SceneController: ['SCENE_TRIGGER', 'ACTIVITY_TRIGGER', 'OTHER'],
    },
  },
  Pushbutton: {
    category: 'SCENE_TRIGGER',
    capabilities: ['SceneController'],
    // Momentary — fits scenes and activities. (DOORBELL excluded for the
    // same reason as Switch: needs Alexa.DoorbellEventSource, which a pure
    // SceneController endpoint can't provide.)
    allowedCategories: ['SCENE_TRIGGER', 'ACTIVITY_TRIGGER', 'OTHER'],
  },
  Dimmer: {
    category: 'LIGHT',
    capabilities: ['PowerController', 'BrightnessController'],
    // Dimmable loads: lights primarily, also some fans.
    allowedCategories: ['LIGHT', 'FAN', 'OTHER'],
  },
  LightControllerV2: {
    category: 'LIGHT',
    capabilities: ['PowerController', 'ModeController'],
    allowedCategories: ['LIGHT', 'OTHER'],
  },
  // LightController (v1) — older Loxone scene-set lighting controller.
  // Same Alexa surface as v2 (PowerController + ModeController) but
  // different Loxone wire format: scenes via the `activeScene` numeric
  // state and `sceneList` CSV text state, vs v2's `activeMoods` JSON
  // array and `moodList` JSON-object format. Commands also differ:
  // v1 takes the raw scene number (e.g., "5"); v2 wraps with "changeTo/".
  // PowerController uses lowercase `on`/`off` (documented in the v17
  // Structure File) rather than v2's capital `On`/`Off`.
  LightController: {
    category: 'LIGHT',
    capabilities: ['PowerController', 'ModeController'],
    allowedCategories: ['LIGHT', 'OTHER'],
  },
  // Note: no PowerController here. ColorPickerV2 has no native On/Off verb
  // on its command surface — sending "On"/"Off" is accepted but inert (the
  // Miniserver ack-echoes value=1 generically). BrightnessController already
  // provides the natural off-switch (brightness=0), and Alexa's voice
  // intent for "turn off X" falls back to brightness=0 on BrightnessController
  // endpoints, so dropping PowerController loses no user-visible function.
  ColorPickerV2: {
    category: 'LIGHT',
    capabilities: ['BrightnessController', 'ColorController', 'ColorTemperatureController'],
    allowedCategories: ['LIGHT', 'OTHER'],
  },
  // Position-style RangeController. All three are blinds-shaped from Alexa's
  // view (0..100, where 100 = fully open) but speak different Loxone command
  // verbs internally — the dispatch in directive-router.js routes by
  // control.type. Gate has no continuous-position command (snap-to-presets);
  // Window has moveToPosition; Jalousie has ManualPosition.
  //
  // `rangeAxisInverted` is the DEFAULT for the per-device "Reverse open/close
  // direction" checkbox in the picker UI. The user can override it for an
  // unusually-wired install (e.g., a Jalousie wired so its motor reports
  // 1.0 = open instead of Loxone's normal 1.0 = closed). The daemon never
  // looks at this field at runtime — it reads the device's stored value
  // from devices.json — but the picker pre-fills the checkbox from here.
  Jalousie: {
    category: 'INTERIOR_BLIND', capabilities: ['RangeController'],
    rangeAxisInverted: true,
    allowedCategories: ['INTERIOR_BLIND', 'EXTERIOR_BLIND', 'OTHER'],
  },
  Window: {
    category: 'INTERIOR_BLIND', capabilities: ['RangeController'],
    rangeAxisInverted: false,
    allowedCategories: ['INTERIOR_BLIND', 'EXTERIOR_BLIND', 'OTHER'],
  },
  Gate: {
    // DOOR (not GARAGE_DOOR) because GARAGE_DOOR has certification-grade
    // requirements we can't meet from a Loxone-only daemon: it demands an
    // Alexa.ModeController with a specific GarageDoor.Position semantics
    // block, a user-set voice PIN before "open" dispatches at all, and
    // skips nl-NL entirely from its supported-locale list. DOOR is permissive
    // — accepts "open"/"close" against RangeController via SetRangeValue —
    // and lets the existing Gate dispatcher in directive-router work
    // unchanged.
    category: 'DOOR', capabilities: ['RangeController'],
    rangeAxisInverted: false,
    allowedCategories: ['DOOR', 'OTHER'],
  },
  // Generic analog Loxone control — Virtual Input (Slider) in Loxone Config.
  // Its own min/max/step from `details` drives Alexa's supportedRange, so a
  // 15..25 °C setpoint stays in degrees and a 0..100 volume stays in percent
  // without rescaling. Catch-all category since the slider's semantics are
  // application-specific (volume? temperature? counter?).
  Slider: {
    category: 'OTHER', capabilities: ['RangeController'],
    rangeAxisInverted: false,
    // Slider is the most semantically open of our types — could be a fan
    // speed, a volume, a heating setpoint, anything analog. Keep the
    // dropdown wide so users can map it to whatever Alexa category best
    // represents the underlying function.
    allowedCategories: ['OTHER', 'FAN', 'SPEAKER', 'LIGHT'],
  },
  // AudioZone / AudioZoneV2 — Loxone Music Server zones. Same Alexa
  // capability set; the only wire-format difference is the source-selection
  // verb (V1: source/{slot}, V2: playZoneFav/{id}), dispatched by type in
  // _handleSetMode. Mute maps to off (Loxone-correct: one speaker silenced,
  // group keeps playing). Shuffle is a read-modify-write toggle since
  // Loxone's `shuffle` command toggles rather than sets explicitly.
  //
  // displayCategory STREAMING_DEVICE (not SPEAKER) follows openhab-alexa's
  // convention for PlaybackController-equipped endpoints. Empirically the
  // Alexa app renders the two categories differently; STREAMING_DEVICE
  // *may* unlock richer tile UI. Either way, semantically a Loxone Music
  // Server zone is a streaming device (audio output that pulls from
  // network sources) more than it's a discrete "speaker."
  //
  // `audioVolumeStep` controls how much "louder"/"quieter" voice commands
  // change the volume when Alexa doesn't specify an amount. Alexa sends
  // volumeDefault=true in that case; we substitute this configured step
  // for the daemon-side delta. Default 5 matches Loxone's typical config.
  AudioZone: {
    category: 'STREAMING_DEVICE',
    capabilities: [
      'PowerController', 'Speaker', 'PlaybackController',
      'PlaybackStateReporter', 'ToggleController', 'ModeController',
    ],
    audioVolumeStep: 5,
    allowedCategories: ['STREAMING_DEVICE', 'SPEAKER', 'MUSIC_SYSTEM', 'OTHER'],
  },
  // AudioZoneV2 (Loxone Audioserver) has NO ModeController and NO
  // ToggleController. Per the Loxone V17 Structure File its command set is
  // volUp/volDown/volume/tts/playZoneFav/prev/next/play/Pause/bluetooth/
  // presence — it supports neither `source/`/`repeat/` (ModeController) nor
  // `shuffle` (ToggleController); those were V1 AudioZone/MusicServer
  // commands. So neither must be selectable in the picker, nor advertised
  // at Discovery (directive-router gates both the audio ModeController and
  // ToggleController blocks to control.type === 'AudioZone').
  AudioZoneV2: {
    category: 'STREAMING_DEVICE',
    capabilities: [
      'PowerController', 'Speaker', 'PlaybackController',
      'PlaybackStateReporter',
    ],
    audioVolumeStep: 5,
    allowedCategories: ['STREAMING_DEVICE', 'SPEAKER', 'MUSIC_SYSTEM', 'OTHER'],
  },
  // IRoomControllerV2 — Loxone's Intelligent Room Controller v2.
  // Pairs ThermostatController (setpoint + mode) with TemperatureSensor
  // (measured room temp) on the same endpoint so the Alexa app renders a
  // proper thermostat tile with both readings.
  //
  // `thermostatUseOverride` defaults to false → SetTargetTemperature writes
  // the schedule's comfort temperature permanently (via
  // setComfortTemperature). When true, writes go through the override
  // command with `thermostatOverrideHours` as the auto-expire duration,
  // leaving the schedule untouched. Both are per-device settings — see the
  // "Settings" row in the picker.
  // InfoOnlyDigital — a Loxone "virtual state" (boolean read-only).
  // The user picks how to expose it: ContactSensor (door/window) or
  // MotionSensor (presence-like). Both are advertised as `optional` so the
  // picker shows both checkboxes; the user toggles whichever fits their
  // wiring. State-reporter emits both candidate properties on every
  // `active` state change; capability filter drops whichever isn't
  // advertised per-device.
  //
  // Mapping (no inversion in v1): value=1 → DETECTED, value=0 → NOT_DETECTED
  // for either capability. Users with inverted wiring (Loxone reports 1
  // when door is open) should invert in Loxone Config.
  InfoOnlyDigital: {
    category: 'CONTACT_SENSOR',
    capabilities: ['ContactSensor'],
    // ModeController is an opt-in third role for users who want custom
    // labels (Full/Empty, Wet/Dry, Armed/Disarmed) instead of Alexa's
    // built-in Open/Closed or Detected/Not-detected text. See the
    // per-device modeLabelActive/Inactive fields.
    optionalCapabilities: ['MotionSensor', 'ModeController'],
    // These three are alternative *renderings of the same binary value*.
    // Alexa technically permits advertising more than one, but it's
    // redundant + confusing (two/three tiles for one door contact). The
    // picker enforces "at most one active" — checking one clears the rest.
    exclusiveCapabilities: ['ContactSensor', 'MotionSensor', 'ModeController'],
    allowedCategories: ['CONTACT_SENSOR', 'MOTION_SENSOR', 'OTHER'],
    // Clean category coupling for the two SENSOR arms only — the picker keeps
    // capability and category in step (pick MOTION_SENSOR → MotionSensor, etc.).
    // The custom-label ModeController arm is deliberately LEFT OUT of the map:
    // it has no natural sensor category, so it stays uncoupled and may use any
    // allowed category. OTHER appears in BOTH mapped lists, so selecting OTHER
    // never force-flips the capability — it's a valid catch-all for every arm,
    // including the unmapped ModeController.
    capabilityCategories: {
      ContactSensor: ['CONTACT_SENSOR', 'OTHER'],
      MotionSensor:  ['MOTION_SENSOR', 'OTHER'],
    },
    // Reed switches on doors/windows commonly report Loxone-active=1 when
    // the contact is OPEN (magnet away). Alexa's wire convention is the
    // opposite: ContactSensor.DETECTED means contact PRESENT (door closed),
    // MotionSensor.DETECTED means motion PRESENT. Defaulting the inversion
    // ON matches the most-common reed-switch wiring; users with the
    // opposite wiring uncheck the box in the picker.
    sensorPolarityInverted: true,
  },
  // InfoOnlyAnalog — a Loxone "virtual state" (numeric read-only).
  // Similar pattern to InfoOnlyDigital: user picks Temperature (°C/°F
  // from `details.format`) or Humidity (plain 0-100). State-reporter
  // emits both candidate properties; capability filter drops one.
  InfoOnlyAnalog: {
    category: 'TEMPERATURE_SENSOR',
    capabilities: ['TemperatureSensor'],
    optionalCapabilities: ['HumiditySensor'],
    // One analog value is EITHER a temperature OR a humidity reading —
    // never both. Exclusive in the picker.
    exclusiveCapabilities: ['TemperatureSensor', 'HumiditySensor'],
    allowedCategories: ['TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'OTHER'],
    // Both arms couple cleanly to a sensor category (no ModeController arm
    // here). OTHER is shared so it never force-flips the capability.
    capabilityCategories: {
      TemperatureSensor: ['TEMPERATURE_SENSOR', 'OTHER'],
      HumiditySensor:    ['HUMIDITY_SENSOR', 'OTHER'],
    },
  },
  // PresenceDetector — Loxone presence/motion sensor. Single `active`
  // state (0/1). Maps cleanly to Alexa.MotionSensor. No directives —
  // pure read-only, with the daemon emitting ChangeReports when the
  // active state transitions.
  PresenceDetector: {
    category: 'MOTION_SENSOR',
    capabilities: ['MotionSensor'],
    // ModeController is the same opt-in custom-label role available on
    // every binary-sensor type — useful if "Detected/Not detected" is
    // the wrong vocabulary for this specific install (e.g., the user
    // wants "Occupied"/"Vacant" instead).
    optionalCapabilities: ['ModeController'],
    exclusiveCapabilities: ['MotionSensor', 'ModeController'],
    allowedCategories: ['MOTION_SENSOR', 'OTHER'],
    // Default inverted to match the rest of the sensor family. For a
    // typical Loxone PresenceDetector (active=1 means motion), the user
    // will uncheck this; for an N.C. (normally-closed) wiring where
    // active=1 means "no motion", the default is correct.
    sensorPolarityInverted: true,
  },
  // WindowMonitor — Loxone aggregator over multiple window/door contact
  // sensors. State is `windowStates`, a comma-separated string where
  // each entry is a per-window bitmask (1=closed, 2=tilted, 4=open).
  // We aggregate: any window not-closed → endpoint reports NOT_DETECTED
  // (Alexa ContactSensor semantic: DETECTED = contact, i.e., closed).
  // A future iteration could expand to one Alexa endpoint per monitored
  // window; v1 keeps it single-endpoint for simplicity.
  WindowMonitor: {
    category: 'CONTACT_SENSOR',
    capabilities: ['ContactSensor'],
    // Same opt-in custom-label role as the other binary sensors. Useful
    // when the WindowMonitor monitors something other than windows
    // (skylights, doors, garage gates) and Open/Closed isn't quite right.
    optionalCapabilities: ['ModeController'],
    exclusiveCapabilities: ['ContactSensor', 'ModeController'],
    allowedCategories: ['CONTACT_SENSOR', 'OTHER'],
    // Same default as other sensors. WindowMonitor's aggregator already
    // emits DETECTED when every window is closed (Alexa-convention);
    // inverting flips it so "any window open" → DETECTED, which feels
    // more natural ("did Alexa detect an open window?"). Default on
    // matches user intuition about windows.
    sensorPolarityInverted: true,
  },
  IRoomControllerV2:   {
    category: 'THERMOSTAT',
    capabilities: ['ThermostatController', 'TemperatureSensor'],
    // HumiditySensor is additive (NOT exclusive): the room controller's
    // `humidityActual` state is a genuine extra reading alongside the
    // thermostat, present only when an indoor-humidity input is wired
    // (Loxone capabilities bitmask bit 14). The picker offers it as an
    // opt-in checkbox; filterOptionalCapabilities() hides it for controls
    // that don't expose `humidityActual` so the user can't pick a role
    // that would always resolve to null. See structure-file spec
    // IRoomControllerV2 @States → humidityActual ("Current indoor humidity").
    optionalCapabilities: ['HumiditySensor'],
    allowedCategories: ['THERMOSTAT', 'AIR_CONDITIONER', 'OTHER'],
    thermostatUseOverride: false,
    thermostatOverrideHours: 12,
  },
  // ACControl — Loxone "AC Control" block. Surfaces:
  //   - PowerController (status on/off via on|off commands)
  //   - ThermostatController.targetSetpoint (setTarget/<temp>)
  //   - ThermostatController.thermostatMode (AUTO/HEAT/COOL ↔ Loxone modes 1/2/3
  //     via setMode/<n>; Alexa OFF is mapped to PowerController.TurnOff,
  //     Loxone modes 4 (Dry) and 5 (Fan) are NOT exposed in v1 — Alexa's
  //     thermostatMode enum has no matching value and CUSTOM requires
  //     Alexa-prescribed customNames that don't fit).
  //   - TemperatureSensor (temperature state)
  //   - ModeController (fan speed, instance Aloxberry.AC.FanSpeed, slot list
  //     parsed from the `fanspeeds` text state JSON)
  // Bounds: minTemp/maxTemp states drive ThermostatController.supportedRange.
  ACControl: {
    category: 'AIR_CONDITIONER',
    capabilities: [
      'PowerController', 'ThermostatController',
      'TemperatureSensor', 'ModeController',
    ],
    allowedCategories: ['AIR_CONDITIONER', 'THERMOSTAT', 'OTHER'],
  },
  // Radio — Loxone "Radio buttons" block (8x or 16x variants). Named-slot
  // picker: N labeled outputs, one active at a time, optional "All Off"
  // (id=0) when details.allOff is set. Pure ModeController fit: each
  // output maps to one supportedMode; SetMode value=N sends "N" to
  // activate (or "reset" for N=0).
  Radio: {
    category: 'OTHER',
    capabilities: ['ModeController'],
    // Most Radio installs are mode pickers ("Heizmodus", "Programmwahl");
    // SWITCH/SCENE_TRIGGER work too if the user's slots are scene-like.
    allowedCategories: ['OTHER', 'SWITCH', 'SCENE_TRIGGER'],
  },
  // Sequential — Loxone "Sequential Controller" block. Same Alexa shape
  // as Radio (ModeController with a named-slot list, one active at a
  // time, id=0 = none); semantically different in that each slot is a
  // time-bounded *program* the block runs to completion. Wire format
  // substitutes: `triggerSequence/{id}` to start, `triggerSequence/0`
  // to stop. SCENE_TRIGGER fits the most natural use cases (orchestrated
  // routines, light shows); ACTIVITY_TRIGGER works for longer programs.
  Sequential: {
    category: 'SCENE_TRIGGER',
    capabilities: ['ModeController'],
    allowedCategories: ['SCENE_TRIGGER', 'ACTIVITY_TRIGGER', 'OTHER'],
  },
  // ValueSelector — Loxone "Push-button +/−" (or "+ only"). Numeric
  // stepper bound to a virtual input. Same Alexa shape as Slider
  // (RangeController), but min/max/step come from per-control STATE
  // rather than the structure's `details` block — those can change at
  // runtime via Loxone logic. `increaseOnly` is enforced daemon-side:
  // AdjustRangeValue with a negative delta on an increase-only control
  // returns INVALID_VALUE.
  ValueSelector: {
    category: 'OTHER',
    capabilities: ['RangeController'],
    allowedCategories: ['OTHER', 'FAN', 'SPEAKER', 'LIGHT', 'THERMOSTAT'],
  },
  // Ventilation — Loxone mechanical-ventilation logic block. Quirk: every
  // write goes through `setTimer/{interval}/{speed}/{modeId}/{timerProfileIdx}`
  // — Loxone has no "set speed permanently" command. Each Alexa
  // interaction becomes a long-duration manual timer (default 24h, per-
  // device override via ventilationOverrideHours). Once the timer expires
  // the block returns to its automatic logic (humidity/CO2/presence driven).
  //
  // TemperatureSensor + HumiditySensor are optional because the
  // corresponding inputs (Hi for humidity, indoor temp from a sensor) may
  // not be wired on every install. Users opt-in per-device via the picker.
  Ventilation: {
    category: 'FAN',
    capabilities: ['PowerController', 'RangeController', 'ModeController'],
    optionalCapabilities: ['TemperatureSensor', 'HumiditySensor'],
    allowedCategories: ['FAN', 'AIR_FRESHENER', 'VENT', 'OTHER'],
    // Hours the manual-timer override applies for. Matches Loxone's
    // `setTimer` interval (in hours, converted to seconds at directive
    // time). User can shorten if they only want voice commands to apply
    // briefly, or lengthen for a near-permanent override.
    ventilationOverrideHours: 24,
  },
  // InfoOnly* sensors are read-only; deferred to Phase 4.
});

function alexaInfoForType(type) {
  return TYPE_MAP[type] || null;
}

// Some optional capabilities are only meaningful when the control actually
// exposes the backing state. IRoomControllerV2 advertises HumiditySensor only
// when an indoor-humidity input is wired (state `humidityActual`, gated by the
// Loxone capabilities bitmask bit 14). Without that state the reading would
// always resolve to null, so we hide the picker checkbox entirely rather than
// offer a role that does nothing. Returns a (possibly empty) array, or null
// when the type declares no optional capabilities at all.
const OPTIONAL_CAPABILITY_REQUIRED_STATE = Object.freeze({
  IRoomControllerV2: Object.freeze({ HumiditySensor: 'humidityActual' }),
});
function filterOptionalCapabilities(type, optionalCaps, states) {
  if (!Array.isArray(optionalCaps)) return null;
  const reqs = OPTIONAL_CAPABILITY_REQUIRED_STATE[type];
  if (!reqs) return [...optionalCaps];
  return optionalCaps.filter((cap) => {
    const needState = reqs[cap];
    return !needState
      || (states && Object.prototype.hasOwnProperty.call(states, needState));
  });
}

// Strict subset — only types whose primary capability is actually wired up
// in the v1 daemon. Used by the picker's "Hide Alexa-incompatible" filter.
const V1_IMPLEMENTED_TYPES = new Set([
  'Switch', 'TimedSwitch', 'Pushbutton',
  'LightController', 'LightControllerV2', 'ColorPickerV2',
  'Jalousie', 'Window', 'Gate', 'Slider',
  'Radio', 'ValueSelector', 'Sequential',
  'IRoomControllerV2', 'ACControl', 'Ventilation',
  'AudioZone', 'AudioZoneV2',
  'PresenceDetector', 'WindowMonitor',
  'InfoOnlyDigital', 'InfoOnlyAnalog',
]);

// Emits:
//   'refreshed' — after a successful fetch+parse from the Miniserver, i.e.
//                 whenever the set of existing controls may have changed.
//                 index.js listens so the Alexa endpoint list can be
//                 re-derived (a control deleted in Loxone Config must stop
//                 being advertised at Discovery without waiting for a
//                 devices.json save or a daemon restart).
class StructureCache extends EventEmitter {
  constructor({ dataDir, log }) {
    super();
    this.cachePath = path.join(dataDir, 'loxapp3.json');
    this.tmpPath = `${this.cachePath}.tmp`;
    this.log = log.child({ component: 'structure' });
    this.parsed = null;        // parsed catalogue (see _parse)
    this.lastFetchedAt = null; // ISO string
    this.stale = false;        // true when serving from disk after a fetch failure
  }

  // Try to refresh from the Miniserver. On failure, fall back to whatever's
  // on disk (with stale=true). Caller decides whether to surface the failure.
  async refresh({ msNo = 1, timeoutMs = 30_000 } = {}) {
    this.log.info({ msNo }, 'fetching LoxAPP3.json from Miniserver');
    let stdout;
    try {
      const result = await execFileP(
        'perl',
        [PERL_HELPER, String(msNo)],
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (err) {
      this.log.warn({ err: err.message }, 'structure fetch failed — falling back to disk cache');
      const fromDisk = await this._loadFromDisk();
      if (fromDisk) {
        this.parsed = fromDisk.parsed;
        this.lastFetchedAt = fromDisk.lastFetchedAt;
        this.stale = true;
        return { ok: false, stale: true, fromCache: true, error: err.message };
      }
      // No cache either — bubble up so caller can surface it.
      throw err;
    }

    // Successful fetch: persist raw to disk, then parse.
    try {
      await fsp.writeFile(this.tmpPath, stdout, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(this.tmpPath, this.cachePath);
    } catch (err) {
      // Cache write failure is non-fatal — we still have the data in memory.
      this.log.warn({ err: err.message }, 'failed to persist loxapp3.json cache');
    }

    let raw;
    try {
      raw = JSON.parse(stdout);
    } catch (err) {
      this.log.error({ err: err.message }, 'LoxAPP3.json is not valid JSON');
      throw err;
    }

    this.parsed = this._parse(raw);
    this.lastFetchedAt = new Date().toISOString();
    this.stale = false;
    this.log.info(
      { controls: this.parsed.controls.length, rooms: this.parsed.rooms.length, cats: this.parsed.cats.length },
      'LoxAPP3 fetched and parsed',
    );
    // Listeners re-derive anything keyed on "which controls exist" — see the
    // class comment. Emitted only on a REAL refresh (never on the disk-cache
    // fallback above), because the disk cache is by definition the structure
    // we already acted on.
    this.emit('refreshed', { controls: this.parsed.controls.length });
    return { ok: true, stale: false, fromCache: false };
  }

  // Load + parse the on-disk cache (used at boot and as fetch fallback).
  async _loadFromDisk() {
    try {
      const text = await fsp.readFile(this.cachePath, 'utf8');
      const stats = await fsp.stat(this.cachePath);
      const raw = JSON.parse(text);
      return {
        parsed: this._parse(raw),
        lastFetchedAt: stats.mtime.toISOString(),
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn({ err: err.message }, 'on-disk loxapp3.json unreadable');
      }
      return null;
    }
  }

  // Best-effort sync init from disk so /catalogue returns something even
  // before the first refresh completes.
  async loadFromDisk() {
    const r = await this._loadFromDisk();
    if (r) {
      this.parsed = r.parsed;
      this.lastFetchedAt = r.lastFetchedAt;
      this.stale = true;
      return true;
    }
    return false;
  }

  // Flatten LoxAPP3.json into a single controls array. Both top-level
  // controls and their subControls become first-class entries in the list;
  // subControls keep a `parentUuid`/`parentName` reference so the picker
  // can group them under their parent.
  _parse(raw) {
    const rooms = raw.rooms || {};
    const cats  = raw.cats  || {};
    const controls = [];

    const roomList = Object.entries(rooms).map(([uuid, r]) => ({
      uuid,
      name: r?.name || '',
      type: r?.type ?? null,
    }));
    const catList = Object.entries(cats).map(([uuid, c]) => ({
      uuid,
      name: c?.name || '',
      type: c?.type ?? null,
    }));

    const pushOne = ({ uuid, ctrl, parentUuid, parentName }) => {
      const type = ctrl?.type || '';
      const info = alexaInfoForType(type);
      const roomUuid = ctrl?.room || (parentUuid ? raw.controls?.[parentUuid]?.room : '') || '';
      const catUuid  = ctrl?.cat  || (parentUuid ? raw.controls?.[parentUuid]?.cat  : '') || '';
      // Capture the control's state-UUID map. Each control declares its
      // states as `{stateName: stateUuid}` — e.g. Switch has `active`,
      // Dimmer has `position`. We keep the raw map so state-reporter can
      // build a reverse index (stateUuid → controlUuid + stateName).
      const states = (ctrl?.states && typeof ctrl.states === 'object')
        ? Object.fromEntries(
            Object.entries(ctrl.states).filter(([, v]) => typeof v === 'string')
          )
        : null;
      controls.push({
        uuid,
        name: ctrl?.name || '',
        type,
        roomUuid,
        roomName: rooms[roomUuid]?.name || '',
        catUuid,
        catName: cats[catUuid]?.name || '',
        parentUuid: parentUuid || null,
        parentName: parentName || null,
        alexaCompatible: !!info,
        v1Implemented: V1_IMPLEMENTED_TYPES.has(type),
        defaults: info ? {
          displayCategory: info.category,
          capabilities: [...info.capabilities],
          // Per-type list of Alexa displayCategories that make sense for
          // this control. The picker filters its category dropdown to
          // this list; absent → picker shows the full CATEGORIES list.
          allowedCategories: Array.isArray(info.allowedCategories)
                               ? [...info.allowedCategories] : null,
          // Per-type list of Alexa capabilities that are valid alternatives
          // to the default set — rendered as additional unchecked checkboxes
          // in the picker. The user can toggle them on (e.g. picking
          // MotionSensor alongside or instead of ContactSensor on an
          // InfoOnlyDigital sensor). On `addDevice` they're NOT added to
          // the device's capabilities — only the primary defaults are.
          // Filtered per-control: an optional capability whose backing state
          // is absent (e.g. IRoomControllerV2 HumiditySensor on a controller
          // without a wired humidity input) is dropped so the picker never
          // offers a role that would always resolve to null.
          optionalCapabilities: filterOptionalCapabilities(
            type, info.optionalCapabilities, states),
          // Capabilities that are alternative renderings of one underlying
          // Loxone value — the picker treats them as a radio-group (at
          // most one active). Null when the type's capabilities are
          // additive (e.g. Ventilation's optional Temp/Humidity sensors,
          // which a real vent unit genuinely has alongside the fan).
          exclusiveCapabilities: Array.isArray(info.exclusiveCapabilities)
                                  ? [...info.exclusiveCapabilities] : null,
          // Picker-only category↔capability linkage (see TYPE_MAP). Passed
          // through verbatim; null for types that don't couple the two.
          capabilityCategories: info.capabilityCategories
                                  ? JSON.parse(JSON.stringify(info.capabilityCategories))
                                  : null,
          // Per-type defaults the picker uses to pre-fill device form
          // fields. Each maps to one Setting-row control in devices.html.
          rangeAxisInverted:       info.rangeAxisInverted === true,
          // TimedSwitch "trigger the timer" opt-in. No control type defaults
          // this on (a fresh TimedSwitch behaves like a plain switch until
          // the user opts in), so it's always false here — but kept in the
          // defaults block so the picker seeds the field uniformly with the
          // other per-device booleans.
          timedSwitchPulse:        info.timedSwitchPulse === true,
          thermostatUseOverride:   info.thermostatUseOverride === true,
          thermostatOverrideHours: Number.isFinite(info.thermostatOverrideHours)
                                     ? info.thermostatOverrideHours : 12,
          audioVolumeStep:         Number.isFinite(info.audioVolumeStep)
                                     ? info.audioVolumeStep : 5,
          // Default inversion for sensor types. The picker pre-fills its
          // "Invert open/closed" checkbox from here; the daemon reads the
          // device's stored value at runtime (not this default).
          sensorPolarityInverted:  info.sensorPolarityInverted === true,
          // Hours the Ventilation manual-timer override applies (1..168).
          // Daemon converts to seconds at setTimer time. Default 24h.
          ventilationOverrideHours: Number.isFinite(info.ventilationOverrideHours)
                                      ? info.ventilationOverrideHours : 24,
        } : null,
        // The address used by lox-control.pl. Loxone is consistent: the
        // top-level control's uuidAction is the URL segment that accepts
        // commands. SubControls have their own uuidAction.
        uuidAction: ctrl?.uuidAction || uuid,
        states,
        // Raw Loxone `details` block — carries per-type config the
        // resolvers need: Radio's `outputs` map, Ventilation's `modes`,
        // Sequential's `sequences`, Slider's min/max/step, the °C/°F
        // `format`, ValueSelector's `increaseOnly`, etc. Without this a
        // Radio resolves to zero outputs → zero capabilities → Alexa
        // rejects the endpoint outright (the "Diavolo Status doesn't
        // appear" bug). Stored verbatim; resolvers read specific keys.
        details: ctrl?.details || null,
      });
    };

    for (const [uuid, ctrl] of Object.entries(raw.controls || {})) {
      pushOne({ uuid, ctrl });
      for (const [subUuid, sub] of Object.entries(ctrl.subControls || {})) {
        pushOne({ uuid: subUuid, ctrl: sub, parentUuid: uuid, parentName: ctrl?.name });
      }
    }

    return {
      lastModified:  raw.lastModified || null,
      msName:        raw.msInfo?.msName || raw.msInfo?.projectName || '',
      msSerial:      raw.msInfo?.serialNr || '',
      rooms: roomList,
      cats:  catList,
      controls,
    };
  }

  getCatalogue() {
    if (!this.parsed) return null;
    return {
      fetchedAt: this.lastFetchedAt,
      stale: this.stale,
      msName:  this.parsed.msName,
      msSerial: this.parsed.msSerial,
      rooms:   this.parsed.rooms,
      cats:    this.parsed.cats,
      controls: this.parsed.controls,
    };
  }

  // Quick by-UUID lookup. Used when the directive router needs to find
  // a control's metadata (e.g. resolve uuidAction at command time).
  getControl(uuid) {
    if (!this.parsed) return null;
    return this.parsed.controls.find((c) => c.uuid === uuid) || null;
  }

  // "Do we hold a structure good enough to answer *negative* questions with?"
  //
  // getControl() returning null is ambiguous on its own: it means either "that
  // control was deleted in Loxone Config" or "we never got a structure at
  // all". Callers that act on absence (orphan detection in devices-config)
  // must distinguish the two, or a Miniserver that is merely unreachable
  // would look like a Miniserver with every control deleted.
  //
  // A structure loaded from the disk cache counts: it is the last state Loxone
  // actually reported, so a control missing from it really was removed. Only
  // "no structure at all" (cold first install, unreadable cache) is untrusted.
  // The empty-controls guard covers a parse that produced nothing usable.
  hasStructure() {
    return !!(this.parsed && this.parsed.controls && this.parsed.controls.length > 0);
  }
}

module.exports = { StructureCache, alexaInfoForType, TYPE_MAP, V1_IMPLEMENTED_TYPES };
