'use strict';

// Alexa Smart Home directive handler.
//
// The entry point is `handle(directive)` which:
//   1. Inspects directive.header.{namespace,name}.
//   2. Dispatches to the appropriate handler.
//   3. Returns an Alexa-shaped response *envelope* (or ErrorResponse).
//
// This is the *daemon-side* counterpart of the Lambda's directive translation.
// The Lambda forwards directives verbatim through the bridge; the daemon
// decides what they mean for the local Loxone install.
//
// MVP scope (step 6):
//   - Alexa.Discovery.Discover       → return a hardcoded test endpoint
//   - Alexa.PowerController.TurnOn   → write "On"/"Off" to the mapped Loxone VI
//   - Alexa.PowerController.TurnOff
//   - Any other namespace/name       → ErrorResponse(INVALID_DIRECTIVE)
//
// Device mapping is currently a static in-memory list per `endpoints` argument.
// Future: read from data/config.json populated by the config UI.

const crypto = require('node:crypto');

const PROTO_VERSION = '3';

// ----- Response builders ----------------------------------------------------

function msgId() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }

function header(namespace, name, payloadVersion = PROTO_VERSION, extra = {}) {
  return { namespace, name, payloadVersion, messageId: msgId(), ...extra };
}

function errorResponse(originalHeader, type, message) {
  return {
    event: {
      header: header('Alexa', 'ErrorResponse', PROTO_VERSION, {
        correlationToken: originalHeader?.correlationToken,
      }),
      payload: { type, message },
    },
  };
}

function discoveryResponse(endpoints) {
  return {
    event: {
      header: header('Alexa.Discovery', 'Discover.Response'),
      payload: { endpoints },
    },
  };
}

// StateReport — answer to Alexa.ReportState. Same shape as a directive
// response but the header is namespace=Alexa, name=StateReport.
// The context.properties array enumerates *current* state for every
// capability the endpoint advertises. Empty payload by convention.
function stateReportResponse(directiveHeader, endpointId, scope, properties) {
  const event = {
    header: header('Alexa', 'StateReport', PROTO_VERSION, {
      correlationToken: directiveHeader.correlationToken,
    }),
    endpoint: { endpointId },
    payload: {},
  };
  // Echo the scope (token-bearing) if Alexa supplied it. Some directive
  // payloads omit this; in that case we omit it too.
  if (scope) event.endpoint.scope = scope;
  return { event, context: { properties } };
}

// Standard "directive done" reply with a state-change context property.
function powerResponse(directiveHeader, endpointId, powerState) {
  return {
    event: {
      header: header('Alexa', 'Response', PROTO_VERSION, {
        correlationToken: directiveHeader.correlationToken,
      }),
      endpoint: { endpointId },
      payload: {},
    },
    context: {
      properties: [
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: powerState,
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 500,
        },
      ],
    },
  };
}

// ----- Router ---------------------------------------------------------------

// Set of directive keys (`${namespace}.${name}`) that effect a write on
// the Miniserver. The vacation gate blocks these when active; everything
// else (Discovery, ReportState, AcceptGrant) passes through so Alexa keeps
// seeing fresh status.
const WRITE_DIRECTIVE_KEYS = new Set([
  'Alexa.PowerController.TurnOn',
  'Alexa.PowerController.TurnOff',
  'Alexa.ModeController.SetMode',
  'Alexa.ModeController.AdjustMode',
  'Alexa.BrightnessController.SetBrightness',
  'Alexa.BrightnessController.AdjustBrightness',
  'Alexa.ColorController.SetColor',
  'Alexa.ColorTemperatureController.SetColorTemperature',
  'Alexa.ColorTemperatureController.IncreaseColorTemperature',
  'Alexa.ColorTemperatureController.DecreaseColorTemperature',
  'Alexa.RangeController.SetRangeValue',
  'Alexa.RangeController.AdjustRangeValue',
  'Alexa.SceneController.Activate',
  'Alexa.ThermostatController.SetTargetTemperature',
  'Alexa.ThermostatController.AdjustTargetTemperature',
  'Alexa.ThermostatController.SetThermostatMode',
  'Alexa.Speaker.SetVolume',
  'Alexa.Speaker.AdjustVolume',
  'Alexa.Speaker.SetMute',
  'Alexa.PlaybackController.Play',
  'Alexa.PlaybackController.Pause',
  'Alexa.PlaybackController.Stop',
  'Alexa.PlaybackController.Next',
  'Alexa.PlaybackController.Previous',
  'Alexa.ToggleController.TurnOn',
  'Alexa.ToggleController.TurnOff',
  // Each is a "write" — keep the list in sync as capabilities are wired.
  //
  // Note: SceneController has no Deactivate verb for us because Loxone
  // Pushbutton is a momentary trigger (Pulse) with no "off" state. We
  // advertise supportsDeactivation=false in Discovery, so Alexa never
  // sends Deactivate to our endpoints.
]);

// The Alexa capabilities whose directives have a handler in this router's
// dispatch (the `switch (key)` block in handle()). This is the canonical
// "what's actually wired" list — local-http.js serves it through /catalogue
// so the picker UI can derive which capability checkboxes are toggleable
// without maintaining its own whitelist (which has drifted before).
//
// Rule for updates: a capability belongs here iff at least one directive in
// its Alexa namespace lands on a real handler (not the default branch). When
// you add a new handler in the dispatch switch, append the capability here.
// When you remove one, prune. The tests verify dispatch handles each entry.
const IMPLEMENTED_CAPABILITIES = Object.freeze([
  'PowerController',
  'BrightnessController',
  'ColorController',
  'ColorTemperatureController',
  'ModeController',
  'RangeController',
  'SceneController',
  'ThermostatController',
  'TemperatureSensor',
  'Speaker',
  'PlaybackController',
  'PlaybackStateReporter',
  'ToggleController',
  'MotionSensor',
  'ContactSensor',
  'HumiditySensor',
]);

// LightControllerV2 mood-controller constants.
//
// `MODE_INSTANCE` is the stable Alexa-side identifier for our ModeController.
// It's part of the directive payload (`header.instance`) so Alexa can route
// SetMode/AdjustMode for multi-mode endpoints — we only have one mode per
// endpoint today but the field is required.
//
// `OFF_MOOD_ID` is Loxone's hard-coded "All Off" preset across every
// LightControllerV2 install. Used to map `activeMoods=[778]` to Alexa's
// PowerController.powerState=OFF. Not user-configurable in Loxone Config.
const MODE_INSTANCE = 'Aloxberry.LightMood';
const OFF_MOOD_ID = 778;

// LightController (v1) scene-controller constants. Distinct instance from
// LightControllerV2's Aloxberry.LightMood so a single Alexa endpoint can't
// route v1 directives into v2 dispatch (or vice versa). Scene 0 is
// hard-coded by Loxone as "all off" across every LightController install.
const MODE_INSTANCE_LIGHT_SCENE = 'Aloxberry.LightScene';
const OFF_SCENE_ID = 0;

// ColorPickerV2 color-temperature bounds. Loxone's typical fixture range is
// 2700-6500 K; values outside that get clamped on the daemon side so we
// don't hand the Miniserver something it can't honour. Step size for the
// stepwise Increase/Decrease directives — chosen to match Alexa's typical
// "warmer / cooler" UX granularity.
const CT_MIN_K = 2700;
const CT_MAX_K = 6500;
const CT_STEP_K = 500;
// Brightness assumed when the user issues "warmer/cooler" on a device whose
// current brightness reads zero (off). Keeps the device from staying dark
// after a temperature step.
const CT_DEFAULT_BRIGHTNESS = 100;
// Neutral kelvin used when SetBrightness is issued on a device whose
// current state cache reads neither HSV nor temp. Picks a comfortable
// daylight-ish value rather than warm-yellow or cold-blue.
const CT_NEUTRAL_K = 4000;

// RangeController instances. Alexa requires the `instance` field on every
// RangeController capability so multi-slider endpoints (position + tilt,
// volume + temperature, etc.) stay disambiguated. We use two:
//
//   BLINDS — Jalousie, Window, Gate. Always 0..100 in Alexa-space where
//            100 = fully open, 0 = fully closed (matches Alexa's NLU for
//            INTERIOR_BLIND/EXTERIOR_BLIND/GARAGE_DOOR). The dispatch on
//            control.type inside _handleSetRangeValue picks the per-type
//            wire format (ManualPosition/<n>, moveToPosition/<n>, or the
//            three-verb snap for Gate).
//   SLIDER — Loxone Virtual-Input Slider. The slider's own min/max/step
//            from `details` drive Alexa's supportedRange; rangeValue is
//            the raw application-specific value (degrees, percent, count).
const RANGE_INSTANCE_BLINDS = 'Aloxberry.Blind.Position';
const RANGE_INSTANCE_SLIDER = 'Aloxberry.Slider.Value';

// Loxone control types whose RangeController is "blind-shaped": fixed
// 0..100 Alexa-space, Open/Close/Half presets, position state as 0..1.
// Each one routes to a different Loxone command verb but shares the
// Alexa-side scale.
const BLIND_TYPES = new Set(['Jalousie', 'Window', 'Gate']);

// Pull Slider config from the structure cache. Slider.details has `min`,
// `max`, `step`, `format`. Default defensively so a malformed structure
// doesn't break Discovery; a real Loxone install populates all four.
function sliderConfig(control) {
  const d = control?.details || {};
  const min  = Number.isFinite(Number(d.min))  ? Number(d.min)  : 0;
  const max  = Number.isFinite(Number(d.max))  ? Number(d.max)  : 100;
  // Step doubles as Alexa's `precision`. Falls back to 1 (integer slider).
  const step = Number.isFinite(Number(d.step)) && Number(d.step) > 0 ? Number(d.step) : 1;
  return { min, max, step };
}

// Range bounds for an endpoint's RangeController. Blind-shaped types are
// always 0..100; Slider reads its own min/max from the structure.
function rangeBoundsFor(control) {
  if (!control) return { min: 0, max: 100, step: 1 };
  if (control.type === 'Slider') return sliderConfig(control);
  return { min: 0, max: 100, step: 1 };
}

// Loxone Dimmer ↔ Alexa brightness scaling. Per Structure File V17 p.59 a
// Dimmer's `position` lives in its configured [min,max] (usually 0..100 but
// configurable per control) and `off` forces position 0. Alexa brightness is
// always 0..100. These two helpers are the SINGLE source of truth for the
// mapping — the directive write path, the ReportState pull path, and the
// state-reporter push path all route through them, so a command→state
// round-trip can't drift. min/max are themselves live Dimmer states; callers
// pass whatever the state cache has, and these default to 0/100 when absent.
function dimmerToBrightness(position, min, max) {
  if (!Number.isFinite(position)) return null;
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 100;
  if (hi <= lo) return position > lo ? 100 : 0;
  return clamp(Math.round(((position - lo) / (hi - lo)) * 100), 0, 100);
}
function brightnessToDimmer(brightness, min, max) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 100;
  if (hi <= lo) return lo;
  return clamp(Math.round(lo + (clamp(brightness, 0, 100) / 100) * (hi - lo)), lo, hi);
}

// Alexa temperature scale ('CELSIUS' | 'FAHRENHEIT') for an IRoomControllerV2.
// Loxone exposes `details.format` per control (typically '°C' or '°F'),
// configured at Miniserver setup time. Default to CELSIUS — most EU
// installs, and matching what users without an explicit format setting
// would expect from a heating control.
function thermostatScaleFor(control) {
  const fmt = String(control?.details?.format || '');
  return /F/i.test(fmt) && !/C/i.test(fmt) ? 'FAHRENHEIT' : 'CELSIUS';
}

// "Mirror around the range" — generalized inversion. For blind-shaped
// (0..100) it collapses to `100 - x`; for a 15..25 slider it's `40 - x`.
// One formula, no per-type case.
function mirrorInRange(value, { min, max }) {
  return max + min - value;
}

// ThermostatController bounds. Most consumer thermostats clamp ~5..35 °C;
// Alexa's voice intent and slider UI work better with a declared range so
// "set bedroom to 50" can be rejected client-side rather than reaching the
// daemon. Loxone's frost/heat protection bounds in the structure would let
// us tighten this per-device, but a generous default is fine for v1.
const TSTAT_MIN_C = 5;
const TSTAT_MAX_C = 35;
// Loxone's epoch: 2009-01-01 00:00:00 UTC. Override-timer `until` is in
// seconds since this anchor, not the Unix epoch. Off-by-1230768000 if you
// forget — the difference between the two epochs in seconds.
const LOXONE_EPOCH_SECONDS = 1230768000;
function unixToLoxoneSeconds(unixSec) {
  return unixSec - LOXONE_EPOCH_SECONDS;
}
// Map Loxone IRoomControllerV2 operatingMode → Alexa thermostatMode.
// Loxone splits auto/manual along an orthogonal axis Alexa doesn't have,
// so we collapse: read maps Manual variants to the corresponding Auto
// (Alexa user sees AUTO/HEAT/COOL regardless of Loxone Auto vs Manual);
// write always uses the Auto variants. The user can still flip into
// Manual from Loxone Config — we just don't surface that distinction.
const LOXONE_OPMODE_BY_ALEXA = Object.freeze({
  AUTO: 0,    // Auto, heating and cooling allowed
  HEAT: 1,    // Auto, only heating allowed
  COOL: 2,    // Auto, only cooling allowed
  OFF:  -1,
});
function alexaModeFromLoxone(opMode) {
  switch (opMode) {
    case 0: case 3: return 'AUTO';
    case 1: case 4: return 'HEAT';
    case 2: case 5: return 'COOL';
    case -1:        return 'OFF';
    default:        return null;  // unknown — caller omits the property
  }
}

// ACControl mode mapping. Loxone documents modes 1-5 (1=Auto, 2=Heat,
// 3=Cool, 4=Dry, 5=Fan); Alexa's ThermostatController.thermostatMode enum
// covers AUTO/HEAT/COOL/OFF (plus ECO/EM_HEAT for niche cases). Dry and
// Fan have no direct Alexa equivalent — we don't expose them in v1.
// Voice control of Dry/Fan goes through Loxone's own app; voice routes
// that hit those modes via Alexa would map to nothing and error.
//
// Alexa OFF doesn't map to a Loxone mode either — it's the device being
// powered off (status=0). The router catches Alexa OFF on the AC and
// routes it through PowerController.TurnOff instead of setMode.
//
// `LOXONE_AC_MODE_BY_ALEXA` lookup returns null for unsupported Alexa
// modes; caller errors with INVALID_VALUE in that case. `alexaModeFromAC`
// returns null for Loxone 4/5 (Dry/Fan); caller omits the property so
// Alexa doesn't see a lying state.
const LOXONE_AC_MODE_BY_ALEXA = Object.freeze({
  AUTO: 1,
  HEAT: 2,
  COOL: 3,
});
function alexaModeFromAC(loxoneMode) {
  switch (Number(loxoneMode)) {
    case 1: return 'AUTO';
    case 2: return 'HEAT';
    case 3: return 'COOL';
    // 4 (Dry) / 5 (Fan) → null. State reporter omits thermostatMode in
    // that case; Alexa shows the last-known mode + powerState=ON.
    default: return null;
  }
}

// Radio: ModeController instance for Loxone's "Radio buttons" picker.
// supportedModes are built from the control's details.outputs map
// (per-install slot names like "Comfort" / "Eco" / "Frost"). SetMode
// value=N sends "N" as the raw command, value=0 sends "reset".
const MODE_INSTANCE_RADIO = 'Aloxberry.Radio';

// Sequential: ModeController instance for Loxone's "Sequential Controller"
// — semantically a list of named PROGRAMS (each a time-bounded routine).
// Same shape as Radio; wire format substitutes `triggerSequence/{id}`
// for activate and `triggerSequence/0` for stop. Distinct instance from
// Radio so the dispatch routes correctly when an install has both types.
const MODE_INSTANCE_SEQUENCE = 'Aloxberry.Sequence';

// Binary-sensor ModeController instance — opt-in alternative role for
// PresenceDetector / WindowMonitor / InfoOnlyDigital. Carries the same
// two states the type's primary capability would, but with user-
// customizable labels (Full/Empty, Wet/Dry, Armed/Disarmed, etc.).
// The ModeController is *read-only*: SetMode on this instance returns
// INVALID_VALUE because there's no underlying write surface — the user
// can't physically "set" their mailbox state.
const MODE_INSTANCE_BINARY_SENSOR = 'Aloxberry.BinarySensor';

// ValueSelector: RangeController instance for the "Push-button +/−"
// numeric stepper. Distinct from Slider's instance so the dispatch can
// route by control type — same wire format (raw value) but bounds come
// from STATE (min/max/step state UUIDs), not the details block.
const RANGE_INSTANCE_VALUE_SELECTOR = 'Aloxberry.ValueSelector';

// Cold-cache fallback bounds for ValueSelector — used at Discovery time
// when the device's min/max/step states haven't arrived yet. We declare
// 0..100/step=1 (Alexa-friendly percent-shaped slider) rather than
// declaring no range; the daemon re-clamps at directive time once the
// live state is known. The structure RE-loads when state arrives, so a
// "Discover devices" refresh after the daemon settles picks up the
// real bounds.
const VALUE_SELECTOR_DEFAULT_BOUNDS = Object.freeze({ min: 0, max: 100, step: 1 });

// Ventilation: RangeController instance for the speed slider (0..100%)
// and ModeController instance for the operating mode (Heat Exchanger /
// Exhaust / etc., per Loxone-Config's details.modes array). Distinct
// instance strings keep Ventilation directives from getting routed
// through the blinds/audio/AC paths.
const RANGE_INSTANCE_VENT_SPEED = 'Aloxberry.Ventilation.Speed';
const MODE_INSTANCE_VENT_MODE   = 'Aloxberry.Ventilation.Mode';

// activeTimerProfile sentinel values per Loxone v17 Structure File p.138:
//   -1: Manual timer active (the only setting we ever write — every Alexa
//       command becomes a manual override)
//   -2: No timer active (block running its automatic logic)
//   -3: Someone is changing settings (transient state in Loxone Config)
const VENT_TIMER_PROFILE_MANUAL = -1;

// ACControl ModeController instance for fan speed. Slot list (0..N) is
// driven by the `fanspeeds` state (JSON array of names) — same shape as
// AudioZone source slots. Default fan-speed names per the v17 KB:
// Off / Auto / Silent / Very Low / Low / Medium / High / Very High.
const MODE_INSTANCE_AC_FAN = 'Aloxberry.AC.FanSpeed';

// AudioZone (V1 + V2) ModeController + ToggleController instances. Two
// dimensions (repeat semantics, current source) plus the shuffle toggle.
// Each instance string MUST match between Discovery, the handler response,
// and the state-reporter — Alexa silently drops property updates whose
// instance doesn't match what Discovery advertised.
const AUDIO_TYPES         = new Set(['AudioZone', 'AudioZoneV2']);
const TOGGLE_INSTANCE_SHUFFLE = 'Aloxberry.Audio.Shuffle';
const MODE_INSTANCE_REPEAT    = 'Aloxberry.Audio.Repeat';
const MODE_INSTANCE_SOURCE    = 'Aloxberry.Audio.Source';

// Loxone `repeat` state values → Alexa mode strings (and reverse). Loxone
// uses 2 as "unused" per docs — only 0/1/3 are valid. We use the same
// strings for Alexa mode values; the daemon never invents a sentinel.
const REPEAT_BY_ALEXA   = Object.freeze({ off: 0, all: 1, one: 3 });
const ALEXA_BY_REPEAT   = Object.freeze({ 0: 'off', 1: 'all', 3: 'one' });

// Loxone `playState` → Alexa playbackState. -1 (unknown) and any other
// value omit the property rather than fabricating a state.
function alexaPlaybackStateFromLoxone(playState) {
  switch (Number(playState)) {
    case 0: return 'STOPPED';
    case 1: return 'PAUSED';
    case 2: return 'PLAYING';
    default: return null;
  }
}

// Parse Loxone's `sourceList` text state — a JSON envelope with the
// user-named zone favorites. Returns [{slot, name}, ...] or [] when
// the envelope can't be parsed (cold cache, malformed, etc.).
function parseSourceList(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const result = parsed?.getroomfavs_result;
  if (!Array.isArray(result) || result.length === 0) return [];
  const items = result[0]?.items;
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    const slot = (typeof it?.slot === 'number') ? it.slot : Number.parseInt(it?.slot, 10);
    if (!Number.isFinite(slot)) continue;
    const name = (typeof it?.name === 'string' && it.name.trim()) ? it.name.trim() : `Source ${slot}`;
    out.push({ slot, name });
  }
  return out;
}

class DirectiveRouter {
  constructor({ loxoneCommand, endpoints = [], log, getGlobals, structureCache, stateCache }) {
    this.loxoneCommand = loxoneCommand;       // LoxoneCommandClient (step 4)
    this.log = log.child({ component: 'directive-router' });
    // The gatekeeper hook is a function, not a value: it's called at
    // directive-handling time so the router always sees fresh state without
    // a coordination dance.
    this.getGlobals       = typeof getGlobals       === 'function' ? getGlobals       : () => null;
    // Optional: when set, the router can look up control metadata (moodList
    // for ModeController, active state for ReportState) at directive-handling
    // time. Discovery falls back to PowerController-only when these are
    // absent so the daemon still serves a useful catalogue during cold start.
    this.structureCache = structureCache || null;
    this.stateCache     = stateCache     || null;
    this.setEndpoints(endpoints);
  }

  // Replace the endpoint set wholesale. Called once at boot and again on
  // every devices.json change. Cheap (rebuilds a Map); no need to diff.
  setEndpoints(endpoints) {
    this.endpoints = Array.isArray(endpoints) ? endpoints : [];
    this.byId = new Map(this.endpoints.map((e) => [e.endpointId, e]));
    this.log.info({ count: this.endpoints.length }, 'endpoints updated');
  }

  // Resolve the boolean state the vacation gate watches.
  //
  // The user picks a Loxone **Virtual Status** (Loxone Config "Virtueller
  // Status" → LoxAPP3 control type `InfoOnlyDigital`, V17 spec p.70) and in
  // Loxone Config wires "<pause condition> → that Virtual Status = On"
  // (e.g. a manual switch, or the Abwesend Betriebsmodus). We deliberately
  // do NOT read Loxone operating modes: `globalStates.operatingMode` only
  // ever exposes the resolved calendar/weekday slot (0..11) and there is
  // NO Loxone API to read the active state of a custom/system Betriebsart
  // (confirmed empirically + V17 spec). A user-wired Virtual Status is the
  // only reliable, mode-agnostic signal, and it arrives over the same WS
  // state stream we already cache.
  //
  // Strictly restricted to InfoOnlyDigital — nothing else is accepted (no
  // other control type, no raw-state-UUID fallback): a wrong pick must
  // fail OPEN and be obvious in the log, never silently gate on the wrong
  // signal.
  _resolveGateState() {
    const g = this.getGlobals();
    if (!g || !g.vacationGate || !g.vacationGate.enabled) {
      return { reason: 'gate_disabled' };
    }
    const controlUuid = g.vacationGate.controlUuid;
    if (!controlUuid || typeof controlUuid !== 'string') {
      return { reason: 'no_control_selected' };
    }
    const ctrl = this.structureCache?.getControl?.(controlUuid);
    if (!ctrl || ctrl.type !== 'InfoOnlyDigital') {
      return { reason: 'not_virtual_status', controlUuid, type: ctrl?.type || null };
    }
    const stateUuid = ctrl.states && ctrl.states.active;
    if (!stateUuid) {
      return { reason: 'no_active_state', controlUuid };
    }
    const entry = this.stateCache?.getValue?.(stateUuid);
    if (!entry || !Number.isFinite(entry.value)) {
      return { reason: 'no_value_yet', controlUuid, stateUuid };
    }
    // Virtual Status On (non-zero) = the user's pause condition is active.
    return {
      controlUuid, stateUuid,
      value: entry.value,
      blocking: entry.value !== 0,
    };
  }

  // Is the vacation gate currently blocking writes?
  //
  // Fail-OPEN (returns false) whenever the gate isn't configured or the
  // watched state hasn't arrived yet — we'd rather briefly over-deliver
  // during the startup warm-up than make a device look unresponsive.
  _isVacationGateActive() {
    const r = this._resolveGateState();
    const blocking = !!(r && r.blocking);
    this.log.debug(
      { ...r, blocking },
      `vacation gate: ${blocking ? 'BLOCKING' : 'not blocking'}`,
    );
    return blocking;
  }

  async handle(directive) {
    const h = directive?.header;
    if (!h || typeof h.namespace !== 'string' || typeof h.name !== 'string') {
      this.log.warn({ directive }, 'malformed directive — no header');
      return errorResponse(h, 'INVALID_DIRECTIVE', 'directive header missing or malformed');
    }
    const key = `${h.namespace}.${h.name}`;
    this.log.info({ key, endpointId: directive?.endpoint?.endpointId }, 'handling directive');

    // Vacation gate: if the configured operating mode is currently active,
    // block *writes* (PowerController etc.) but let reads (Discovery,
    // ReportState) and auth (AcceptGrant) through. This is the daemon-side
    // realization of the "Pause Alexa commands on operating mode" toggle
    // in the picker.
    if (WRITE_DIRECTIVE_KEYS.has(key) && this._isVacationGateActive()) {
      this.log.info({ key, endpointId: directive?.endpoint?.endpointId },
        'vacation gate active — refusing write directive');
      return errorResponse(h, 'NOT_IN_OPERATION',
        'Aloxberry is paused — the configured Loxone operating mode is active.');
    }

    try {
      switch (key) {
        case 'Alexa.Discovery.Discover':
          return this._handleDiscover(directive);

        case 'Alexa.PowerController.TurnOn':
        case 'Alexa.PowerController.TurnOff':
          return await this._handlePower(directive);

        case 'Alexa.ModeController.SetMode':
          return await this._handleSetMode(directive);

        case 'Alexa.ModeController.AdjustMode':
          return await this._handleAdjustMode(directive);

        case 'Alexa.BrightnessController.SetBrightness':
          return await this._handleSetBrightness(directive, /* relative */ false);

        case 'Alexa.BrightnessController.AdjustBrightness':
          return await this._handleSetBrightness(directive, /* relative */ true);

        case 'Alexa.ColorController.SetColor':
          return await this._handleSetColor(directive);

        case 'Alexa.ColorTemperatureController.SetColorTemperature':
          return await this._handleSetColorTemperature(directive);

        case 'Alexa.ColorTemperatureController.IncreaseColorTemperature':
          return await this._handleStepColorTemperature(directive, +CT_STEP_K);

        case 'Alexa.ColorTemperatureController.DecreaseColorTemperature':
          return await this._handleStepColorTemperature(directive, -CT_STEP_K);

        case 'Alexa.RangeController.SetRangeValue':
          return await this._handleSetRangeValue(directive, /* relative */ false);

        case 'Alexa.RangeController.AdjustRangeValue':
          return await this._handleSetRangeValue(directive, /* relative */ true);

        case 'Alexa.SceneController.Activate':
          return await this._handleSceneActivate(directive);

        case 'Alexa.ThermostatController.SetTargetTemperature':
          return await this._handleSetTargetTemperature(directive, /* relative */ false);

        case 'Alexa.ThermostatController.AdjustTargetTemperature':
          return await this._handleSetTargetTemperature(directive, /* relative */ true);

        case 'Alexa.ThermostatController.SetThermostatMode':
          return await this._handleSetThermostatMode(directive);

        case 'Alexa.Speaker.SetVolume':
          return await this._handleSetVolume(directive, /* relative */ false);

        case 'Alexa.Speaker.AdjustVolume':
          return await this._handleSetVolume(directive, /* relative */ true);

        case 'Alexa.Speaker.SetMute':
          return await this._handleSetMute(directive);

        case 'Alexa.PlaybackController.Play':
        case 'Alexa.PlaybackController.Pause':
        case 'Alexa.PlaybackController.Stop':
        case 'Alexa.PlaybackController.Next':
        case 'Alexa.PlaybackController.Previous':
          return await this._handlePlayback(directive);

        case 'Alexa.ToggleController.TurnOn':
        case 'Alexa.ToggleController.TurnOff':
          return await this._handleToggle(directive);

        case 'Alexa.ReportState':
          // Fired by Alexa right after Discovery (and periodically thereafter)
          // to populate / refresh the device's current state in the app UI.
          // If we don't answer, Alexa marks the device unresponsive — which
          // a user reads as "discovery failed".
          return this._handleReportState(directive);

        case 'Alexa.Authorization.AcceptGrant':
          // Lambda already handles AcceptGrant for the LWA token exchange;
          // if one ever reaches the daemon it's spurious. Acknowledge cleanly
          // rather than confusing Alexa with an error.
          return {
            event: {
              header: header('Alexa.Authorization', 'AcceptGrant.Response'),
              payload: {},
            },
          };

        default:
          this.log.info({ key }, 'unsupported directive');
          return errorResponse(h, 'INVALID_DIRECTIVE', `Directive ${key} is not implemented`);
      }
    } catch (err) {
      this.log.error({ err: err.message, key }, 'directive handler threw');
      return errorResponse(h, 'INTERNAL_ERROR', err.message);
    }
  }

  // ----- handlers ---------------------------------------------------------

  _handleDiscover(_directive) {
    // Each endpoint our daemon exposes. For MVP we generate the Alexa shape
    // from our local endpoint config.
    const endpoints = this.endpoints.map((e) => ({
      endpointId: e.endpointId,
      manufacturerName: 'Aloxberry',
      friendlyName: e.friendlyName,
      description: e.description || `${e.friendlyName} (Loxone)`,
      displayCategories: e.displayCategories || ['SWITCH'],
      capabilities: this._capabilitiesFor(e),
    }));
    return discoveryResponse(endpoints);
  }

  _capabilitiesFor(endpoint) {
    const caps = [
      // Every endpoint advertises Alexa@v3 (the base interface).
      { type: 'AlexaInterface', interface: 'Alexa', version: PROTO_VERSION },
    ];
    if (endpoint.capabilities?.includes('PowerController')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.PowerController',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'powerState' }],
          retrievable: true,
          // Phase 4 emits ChangeReports for PowerController state, so we
          // truthfully advertise proactivelyReported = true.
          proactivelyReported: true,
        },
      });
    }

    // BrightnessController — currently only for ColorPickerV2 (parent
    // control). Future: also for Dimmer once that's wired. Phase 4 ChangeReports
    // are wired in state-reporter.js, so proactivelyReported is truthful.
    if (endpoint.capabilities?.includes('BrightnessController')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.BrightnessController',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'brightness' }],
          retrievable: true,
          proactivelyReported: true,
        },
      });
    }
    // ColorController — ColorPickerV2 HSV writes (mutually exclusive with
    // ColorTemperatureController at the Loxone side, but Alexa exposes
    // both simultaneously and we route based on which directive arrives).
    if (endpoint.capabilities?.includes('ColorController')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.ColorController',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'color' }],
          retrievable: true,
          proactivelyReported: true,
        },
      });
    }
    // ColorTemperatureController — Loxone's temp(brightness,kelvin) mode.
    if (endpoint.capabilities?.includes('ColorTemperatureController')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.ColorTemperatureController',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'colorTemperatureInKelvin' }],
          retrievable: true,
          proactivelyReported: true,
        },
      });
    }
    // SceneController for Pushbutton (fire-and-forget trigger). The interface
    // has no `properties` block at all — scenes are events, not state — so
    // there's nothing for ReportState / ChangeReport to do. `supportsDeactivation`
    // is explicitly false: Loxone Pushbutton is momentary (Pulse), there is
    // no reverse action. With this flag, Alexa never sends Deactivate to us.
    if (endpoint.capabilities?.includes('SceneController')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.SceneController',
        version: PROTO_VERSION,
        supportsDeactivation: false,
      });
    }
    // RangeController. Two flavors depending on the Loxone control type:
    //   - Blind-shaped (Jalousie/Window/Gate): fixed 0..100 axis, Open/Close
    //     /Half presets, mapped to whichever Loxone command verb that type
    //     accepts at write time.
    //   - Slider: native min/max/step from the Loxone control's `details`.
    //     No presets (the slider's semantics are user-defined).
    if (endpoint.capabilities?.includes('RangeController')) {
      const control = this.structureCache?.getControl(endpoint.uuid);
      const isSlider = control?.type === 'Slider';
      const isVentilation = control?.type === 'Ventilation';
      const isValueSelector = control?.type === 'ValueSelector';
      if (isValueSelector) {
        // ValueSelector: bounds from live state (min/max/step state UUIDs).
        // Cold cache → defaults from VALUE_SELECTOR_DEFAULT_BOUNDS. Format
        // string in details.format gives us a unit hint (°C/°F/%), but
        // Alexa's unitOfMeasure enum only covers a fixed set — we don't
        // surface a specific unit so the slider stays generic. The user
        // tells Alexa what the device controls via friendlyName.
        const bounds = this._resolveValueSelectorBounds(endpoint);
        caps.push({
          type: 'AlexaInterface',
          interface: 'Alexa.RangeController',
          instance: RANGE_INSTANCE_VALUE_SELECTOR,
          version: PROTO_VERSION,
          properties: {
            supported: [{ name: 'rangeValue' }],
            retrievable: true,
            proactivelyReported: true,
          },
          capabilityResources: {
            friendlyNames: [
              { '@type': 'text', value: { text: 'Value', locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Wert',  locale: 'de-DE' } },
            ],
          },
          configuration: {
            supportedRange: {
              minimumValue: bounds.min,
              maximumValue: bounds.max,
              precision: bounds.step,
            },
            // No presets — ValueSelector's semantics are install-specific.
          },
        });
      } else if (isVentilation) {
        // Ventilation speed slider: 0..100% with named presets that match
        // typical Alexa voice phrasings ("set ventilation to high",
        // "make the ventilation fastest"). Distinct instance from blinds
        // and slider so SetRangeValue routes to the setTimer wire path.
        caps.push({
          type: 'AlexaInterface',
          interface: 'Alexa.RangeController',
          instance: RANGE_INSTANCE_VENT_SPEED,
          version: PROTO_VERSION,
          properties: {
            supported: [{ name: 'rangeValue' }],
            retrievable: true,
            proactivelyReported: true,
          },
          capabilityResources: {
            friendlyNames: [
              { '@type': 'asset', value: { assetId: 'Alexa.Setting.FanSpeed' } },
              { '@type': 'text',  value: { text: 'Speed',         locale: 'en-US' } },
              { '@type': 'text',  value: { text: 'Drehzahl',      locale: 'de-DE' } },
              { '@type': 'text',  value: { text: 'Geschwindigkeit', locale: 'de-DE' } },
            ],
          },
          configuration: {
            supportedRange: { minimumValue: 0, maximumValue: 100, precision: 1 },
            unitOfMeasure: 'Alexa.Unit.Percent',
            presets: [
              {
                rangeValue: 100,
                presetResources: {
                  friendlyNames: [
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Maximum' } },
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.High' } },
                  ],
                },
              },
              {
                rangeValue: 75,
                presetResources: {
                  friendlyNames: [
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.High' } },
                  ],
                },
              },
              {
                rangeValue: 50,
                presetResources: {
                  friendlyNames: [
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Medium' } },
                  ],
                },
              },
              {
                rangeValue: 25,
                presetResources: {
                  friendlyNames: [
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Low' } },
                  ],
                },
              },
              {
                rangeValue: 0,
                presetResources: {
                  friendlyNames: [
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Minimum' } },
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Low' } },
                  ],
                },
              },
            ],
          },
        });
      } else if (isSlider) {
        const { min, max, step } = sliderConfig(control);
        caps.push({
          type: 'AlexaInterface',
          interface: 'Alexa.RangeController',
          instance: RANGE_INSTANCE_SLIDER,
          version: PROTO_VERSION,
          properties: {
            supported: [{ name: 'rangeValue' }],
            retrievable: true,
            proactivelyReported: true,
          },
          capabilityResources: {
            // No standard Alexa asset for a generic "slider value", so we
            // ship locale-text only. The endpoint's friendlyName already
            // names the device ("Volume", "Heizung-Sollwert", etc.).
            friendlyNames: [
              { '@type': 'text', value: { text: 'Value', locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Wert',  locale: 'de-DE' } },
            ],
          },
          configuration: {
            supportedRange: { minimumValue: min, maximumValue: max, precision: step },
            // No presets — the slider's meaning (temperature? volume?) is
            // application-specific. Voice phrases land directly on values.
          },
        });
      } else {
        // Blind-shaped (Jalousie / Window / Gate).
        caps.push({
          type: 'AlexaInterface',
          interface: 'Alexa.RangeController',
          instance: RANGE_INSTANCE_BLINDS,
          version: PROTO_VERSION,
          properties: {
            supported: [{ name: 'rangeValue' }],
            retrievable: true,
            proactivelyReported: true,
          },
          capabilityResources: {
            friendlyNames: [
              { '@type': 'asset', value: { assetId: 'Alexa.Setting.Opening' } },
              { '@type': 'text',  value: { text: 'Position', locale: 'en-US' } },
              { '@type': 'text',  value: { text: 'Position', locale: 'de-DE' } },
            ],
          },
          configuration: {
            supportedRange: { minimumValue: 0, maximumValue: 100, precision: 1 },
            unitOfMeasure: 'Alexa.Unit.Percent',
            presets: [
              {
                rangeValue: 100,
                presetResources: {
                  friendlyNames: [
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Open' } },
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Maximum' } },
                  ],
                },
              },
              {
                rangeValue: 0,
                presetResources: {
                  friendlyNames: [
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Close' } },
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Minimum' } },
                  ],
                },
              },
              {
                rangeValue: 50,
                presetResources: {
                  friendlyNames: [
                    { '@type': 'asset', value: { assetId: 'Alexa.Value.Medium' } },
                    { '@type': 'text',  value: { text: 'Half', locale: 'en-US' } },
                    { '@type': 'text',  value: { text: 'Halb', locale: 'de-DE' } },
                  ],
                },
              },
            ],
          },
        });
      }
    }
    // ModeController for LightController/V2 — modes are the Loxone moods
    // (v2) or scenes (v1). Only added if (a) the device opted in via
    // capabilities config AND (b) we can resolve a non-empty list right
    // now. Cold-start Discovery sees an empty list (state hasn't arrived
    // yet) and gracefully degrades to PowerController-only; the user
    // re-running "Alexa, discover my devices" after the daemon settles
    // picks up the full capability.
    if (endpoint.capabilities?.includes('ModeController')) {
      // v2 and v1 use different state names + parse formats but produce
      // the same [{id, name}] shape. Pick the resolver by control type
      // and the instance string accordingly so directives can dispatch.
      const control = this.structureCache?.getControl(endpoint.uuid);
      const isV1 = control?.type === 'LightController';
      const modes = isV1 ? this._resolveScenes(endpoint) : this._resolveMoods(endpoint);
      const instance = isV1 ? MODE_INSTANCE_LIGHT_SCENE : MODE_INSTANCE;
      if (modes && modes.length > 0) {
        caps.push({
          type: 'AlexaInterface',
          interface: 'Alexa.ModeController',
          instance,
          version: PROTO_VERSION,
          properties: {
            supported: [{ name: 'mode' }],
            retrievable: true,
            proactivelyReported: true,
          },
          capabilityResources: {
            // Names the user can refer to this controller by ("set the
            // light's mood to ...", "set the light's scene to ..."). Both
            // EN and DE so a German Alexa account understands the same
            // phrasing as an English one.
            friendlyNames: [
              { '@type': 'text', value: { text: 'Mood',     locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Scene',    locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Stimmung', locale: 'de-DE' } },
              { '@type': 'text', value: { text: 'Szene',    locale: 'de-DE' } },
            ],
          },
          configuration: {
            ordered: false,
            supportedModes: modes.map((m) => ({
              value: String(m.id),
              modeResources: {
                // Loxone-Config mood/scene names are already in the user's
                // preferred language — declare them under both common
                // locales so voice match works regardless of which
                // Alexa marketplace the user's account is in.
                friendlyNames: [
                  { '@type': 'text', value: { text: m.name, locale: 'en-US' } },
                  { '@type': 'text', value: { text: m.name, locale: 'de-DE' } },
                ],
              },
            })),
          },
        });
      }
    }
    // ThermostatController + TemperatureSensor for IRoomControllerV2.
    // Alexa renders this pair as a proper thermostat tile (setpoint + mode
    // controls + current-temperature readout). We declare both AUTO/HEAT/
    // COOL/OFF as supported modes; the daemon's _handleSetThermostatMode
    // routes the chosen mode to Loxone's setOperatingMode.
    //
    // Temperature scale is per-endpoint (an installation can mix Celsius
    // and Fahrenheit rooms). We read details.format from the structure;
    // anything containing "F" maps to FAHRENHEIT, otherwise CELSIUS.
    if (endpoint.capabilities?.includes('ThermostatController')) {
      // Mode list differs by control type:
      //   IRoomControllerV2: AUTO/HEAT/COOL/OFF (OFF derived from operatingMode=-1)
      //   ACControl:         AUTO/HEAT/COOL     (OFF handled via PowerController;
      //                                          Dry/Fan are Loxone-only)
      const ctrl = this.structureCache?.getControl(endpoint.uuid);
      const supportedModes = ctrl?.type === 'ACControl'
        ? ['AUTO', 'HEAT', 'COOL']
        : ['AUTO', 'HEAT', 'COOL', 'OFF'];
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.ThermostatController',
        // ThermostatController uses the 3.2 schema, not plain 3. Newer
        // features (adaptiveRecoveryStatus, EM_HEAT mode) require it;
        // declaring 3 may cause Alexa to fall back to a degraded renderer.
        version: '3.2',
        properties: {
          supported: [
            { name: 'targetSetpoint' },
            { name: 'thermostatMode' },
          ],
          retrievable: true,
          proactivelyReported: true,
        },
        configuration: {
          supportsScheduling: false,   // Loxone has Daytimer — out of v1 scope
          supportedModes,
        },
      });
    }
    if (endpoint.capabilities?.includes('TemperatureSensor')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.TemperatureSensor',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'temperature' }],
          retrievable: true,
          proactivelyReported: true,
        },
      });
    }
    // Audio (AudioZone / AudioZoneV2). Speaker (volume) + PlaybackController
    // (transport) + PlaybackStateReporter (current state) are unconditional;
    // ToggleController(Shuffle) and ModeController(Repeat/Source) are gated
    // on capability presence so a user can disable any of them per-device.
    // Source mode list is derived from the sourceList state; cold cache
    // emits numeric "Source 1..8" fallbacks so Discovery never blocks.
    const control = this.structureCache?.getControl(endpoint.uuid);
    const isAudio = control && AUDIO_TYPES.has(control.type);
    if (endpoint.capabilities?.includes('Speaker')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.Speaker',
        version: PROTO_VERSION,
        properties: {
          // Spec requires BOTH `volume` and `muted` in supported (the docs'
          // example lists them as two-of-two; we previously declared only
          // `volume` which is a schema violation that may cause Alexa to
          // silently degrade the capability — similar to the missing
          // `properties:{}` we hit on PlaybackController). `muted` is
          // derived from the Loxone power state (off ⇒ muted) since
          // Loxone has no separate mute axis.
          // Ref: developer.amazon.com/.../alexa-speaker.html
          supported: [
            { name: 'volume' },
            { name: 'muted'  },
          ],
          retrievable: true,
          proactivelyReported: true,
        },
      });
    }
    if (endpoint.capabilities?.includes('PlaybackController')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.PlaybackController',
        version: PROTO_VERSION,
        // Spec requires properties:{} (empty object) at the top level even
        // though PlaybackController has no readable state properties. Alexa
        // schema-validates Discovery payloads strictly; omitting this empty
        // object causes Alexa to silently drop the capability — voice "next
        // on <device>" routes nowhere because Alexa thinks our endpoint
        // doesn't actually advertise PlaybackController.
        // Ref: developer.amazon.com/.../alexa-playbackcontroller.html
        properties: {},
        // Loxone has no separate Stop verb — we map Alexa Stop to `pause`
        // for graceful behavior. Advertise it anyway so voice "stop the
        // music" routes here rather than failing.
        supportedOperations: ['Play', 'Pause', 'Stop', 'Next', 'Previous'],
      });
    }
    if (endpoint.capabilities?.includes('PlaybackStateReporter')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.PlaybackStateReporter',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'playbackState' }],
          retrievable: true,
          proactivelyReported: true,
        },
      });
    }
    if (isAudio && endpoint.capabilities?.includes('ToggleController')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.ToggleController',
        instance: TOGGLE_INSTANCE_SHUFFLE,
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'toggleState' }],
          retrievable: true,
          proactivelyReported: true,
        },
        capabilityResources: {
          friendlyNames: [
            { '@type': 'text', value: { text: 'Shuffle',      locale: 'en-US' } },
            { '@type': 'text', value: { text: 'Zufall',       locale: 'de-DE' } },
            { '@type': 'text', value: { text: 'Random',       locale: 'en-US' } },
            { '@type': 'text', value: { text: 'Zufallsmodus', locale: 'de-DE' } },
          ],
        },
      });
    }
    if (isAudio && endpoint.capabilities?.includes('ModeController')) {
      // Repeat: three-mode picker. Mode values are the string keys, the
      // handler maps to Loxone's numeric `repeat/{n}` via REPEAT_BY_ALEXA.
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.ModeController',
        instance: MODE_INSTANCE_REPEAT,
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'mode' }],
          retrievable: true,
          proactivelyReported: true,
        },
        capabilityResources: {
          friendlyNames: [
            { '@type': 'text', value: { text: 'Repeat',       locale: 'en-US' } },
            { '@type': 'text', value: { text: 'Wiederholung', locale: 'de-DE' } },
          ],
        },
        configuration: {
          ordered: false,
          supportedModes: [
            { value: 'off', modeResources: { friendlyNames: [
              { '@type': 'text', value: { text: 'Off',  locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Aus',  locale: 'de-DE' } },
            ] } },
            { value: 'all', modeResources: { friendlyNames: [
              { '@type': 'text', value: { text: 'All',  locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Alle', locale: 'de-DE' } },
            ] } },
            { value: 'one', modeResources: { friendlyNames: [
              { '@type': 'text', value: { text: 'One',         locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Track',       locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Einer',       locale: 'de-DE' } },
              { '@type': 'text', value: { text: 'Titel',       locale: 'de-DE' } },
            ] } },
          ],
        },
      });

      // Source: V1 AudioZone ONLY.
      //
      // AudioZone = Loxone MusicServer (EOL, Logitech-SqueezeBox-based);
      // AudioZoneV2 = its Loxone-built successor, the Audioserver.
      //
      // The Loxone V17 Structure File exposes zone favorites via the
      // `sourceList` text-state on AudioZone (MusicServer, p.35). The
      // Audioserver's AudioZoneV2 has NO favorites surface on the
      // Miniserver at all — its documented state set contains no
      // `sourceList`/`source` (Structure File pp.39-40), and the
      // audio-server API that actually holds the favorites is explicitly
      // "not publicly available" (Structure File p.14). Advertising the
      // generic numbered fallback for V2 is worse than nothing: Alexa
      // would show fake "Source 1..8" modes that map to unknown
      // favorites. So we do not expose Source for V2 — a future
      // Audioserver-direct integration is tracked in
      // doc/user/*/devices.md ("Audioserver (AudioZoneV2) favorites").
      const sources = (control.type === 'AudioZone')
        ? this._resolveSourceList(endpoint)
        : [];
      if (sources.length > 0) {
        caps.push({
          type: 'AlexaInterface',
          interface: 'Alexa.ModeController',
          instance: MODE_INSTANCE_SOURCE,
          version: PROTO_VERSION,
          properties: {
            supported: [{ name: 'mode' }],
            retrievable: true,
            proactivelyReported: true,
          },
          capabilityResources: {
            friendlyNames: [
              { '@type': 'text', value: { text: 'Source',  locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Station', locale: 'en-US' } },
              { '@type': 'text', value: { text: 'Quelle',  locale: 'de-DE' } },
              { '@type': 'text', value: { text: 'Sender',  locale: 'de-DE' } },
            ],
          },
          configuration: {
            ordered: false,
            supportedModes: sources.map((s) => ({
              value: String(s.slot),
              modeResources: {
                friendlyNames: [
                  // The user's favorite name from Loxone Music Server.
                  // Already in their preferred language; declare both locales
                  // so a German Alexa account understands the same string.
                  { '@type': 'text', value: { text: s.name, locale: 'en-US' } },
                  { '@type': 'text', value: { text: s.name, locale: 'de-DE' } },
                ],
              },
            })),
          },
        });
      }
    }
    // Radio (Loxone "Radio buttons") ModeController. Slot list from
    // details.outputs (+ optional All Off id=0). Structure-only — never
    // needs state cache, so available immediately on Discovery.
    if (endpoint.capabilities?.includes('ModeController')) {
      const ctrlRadio = this.structureCache?.getControl(endpoint.uuid);
      if (ctrlRadio?.type === 'Radio') {
        const outputs = this._resolveRadioOutputs(endpoint);
        if (outputs && outputs.length > 0) {
          caps.push({
            type: 'AlexaInterface',
            interface: 'Alexa.ModeController',
            instance: MODE_INSTANCE_RADIO,
            version: PROTO_VERSION,
            properties: {
              supported: [{ name: 'mode' }],
              retrievable: true,
              proactivelyReported: true,
            },
            capabilityResources: {
              friendlyNames: [
                { '@type': 'asset', value: { assetId: 'Alexa.Setting.Mode' } },
                { '@type': 'text',  value: { text: 'Mode',     locale: 'en-US' } },
                { '@type': 'text',  value: { text: 'Modus',    locale: 'de-DE' } },
                { '@type': 'text',  value: { text: 'Auswahl',  locale: 'de-DE' } },
              ],
            },
            configuration: {
              // Loxone Radio outputs have no inherent order — the user
              // configures them per slot. `ordered: false` lets Alexa
              // accept arbitrary slot names without inferring a sequence
              // from the slot numbers.
              ordered: false,
              supportedModes: outputs.map((o) => ({
                value: String(o.id),
                modeResources: {
                  friendlyNames: [
                    { '@type': 'text', value: { text: o.name, locale: 'en-US' } },
                    { '@type': 'text', value: { text: o.name, locale: 'de-DE' } },
                  ],
                },
              })),
            },
          });
        }
      }
    }
    // Binary-sensor ModeController. Opt-in alternative role for any of
    // the three sensor types (PresenceDetector / WindowMonitor /
    // InfoOnlyDigital) when the user wants custom labels instead of
    // Alexa's built-in Open/Closed (ContactSensor) or Detected/Not detected
    // (MotionSensor). Two slots: "0" = inactive, "1" = active, with the
    // user's free-text labels from endpoint.modeLabelActive/Inactive.
    // Empty labels fall back to "Active"/"Inactive" so Discovery never
    // ships a blank slot name. SetMode is rejected by the dispatch since
    // these are physical sensors with no write surface.
    if (endpoint.capabilities?.includes('ModeController')) {
      const ctrlBs = this.structureCache?.getControl(endpoint.uuid);
      const isBinary = ctrlBs && (
        ctrlBs.type === 'PresenceDetector' ||
        ctrlBs.type === 'WindowMonitor' ||
        ctrlBs.type === 'InfoOnlyDigital'
      );
      if (isBinary) {
        const labelActive   = (endpoint.modeLabelActive   || '').trim() || 'Active';
        const labelInactive = (endpoint.modeLabelInactive || '').trim() || 'Inactive';
        caps.push({
          type: 'AlexaInterface',
          interface: 'Alexa.ModeController',
          instance: MODE_INSTANCE_BINARY_SENSOR,
          version: PROTO_VERSION,
          properties: {
            supported: [{ name: 'mode' }],
            retrievable: true,
            proactivelyReported: true,
          },
          capabilityResources: {
            friendlyNames: [
              { '@type': 'asset', value: { assetId: 'Alexa.Setting.Mode' } },
              { '@type': 'text',  value: { text: 'State',  locale: 'en-US' } },
              { '@type': 'text',  value: { text: 'Status', locale: 'en-US' } },
              { '@type': 'text',  value: { text: 'Status', locale: 'de-DE' } },
              { '@type': 'text',  value: { text: 'Zustand', locale: 'de-DE' } },
            ],
          },
          configuration: {
            // The two slots have a natural order in user vocabulary
            // (Empty before Full, Closed before Open, Dry before Wet,
            // etc.) — declare ordered so Alexa's "AdjustMode" intent
            // can step through them coherently. Whether this actually
            // dispatches anywhere is moot because SetMode is rejected;
            // it's still the right semantic.
            ordered: true,
            supportedModes: [
              {
                value: '0',
                modeResources: {
                  friendlyNames: [
                    { '@type': 'text', value: { text: labelInactive, locale: 'en-US' } },
                    { '@type': 'text', value: { text: labelInactive, locale: 'de-DE' } },
                  ],
                },
              },
              {
                value: '1',
                modeResources: {
                  friendlyNames: [
                    { '@type': 'text', value: { text: labelActive, locale: 'en-US' } },
                    { '@type': 'text', value: { text: labelActive, locale: 'de-DE' } },
                  ],
                },
              },
            ],
          },
        });
      }
    }
    // Sequential ("Sequential Controller") ModeController. Same shape as
    // Radio; resolver synthesizes a "None" slot at id=0 so users can voice
    // "set the routine to none" → triggerSequence/0 (stops any running).
    if (endpoint.capabilities?.includes('ModeController')) {
      const ctrlSeq = this.structureCache?.getControl(endpoint.uuid);
      if (ctrlSeq?.type === 'Sequential') {
        const seqs = this._resolveSequences(endpoint);
        if (seqs && seqs.length > 0) {
          caps.push({
            type: 'AlexaInterface',
            interface: 'Alexa.ModeController',
            instance: MODE_INSTANCE_SEQUENCE,
            version: PROTO_VERSION,
            properties: {
              supported: [{ name: 'mode' }],
              retrievable: true,
              proactivelyReported: true,
            },
            capabilityResources: {
              friendlyNames: [
                { '@type': 'asset', value: { assetId: 'Alexa.Setting.Mode' } },
                { '@type': 'text',  value: { text: 'Program',  locale: 'en-US' } },
                { '@type': 'text',  value: { text: 'Routine',  locale: 'en-US' } },
                { '@type': 'text',  value: { text: 'Programm', locale: 'de-DE' } },
                { '@type': 'text',  value: { text: 'Ablauf',   locale: 'de-DE' } },
              ],
            },
            configuration: {
              ordered: false,
              supportedModes: seqs.map((s) => ({
                value: String(s.id),
                modeResources: {
                  friendlyNames: [
                    { '@type': 'text', value: { text: s.name, locale: 'en-US' } },
                    { '@type': 'text', value: { text: s.name, locale: 'de-DE' } },
                  ],
                },
              })),
            },
          });
        }
      }
    }
    // Ventilation mode ModeController. Mode list comes from details.modes
    // (configured per-install in Loxone Config: Heat Exchanger / Exhaust
    // / Bypass / etc.). Always populated from the *structure* (not state
    // cache), so this is available as soon as the structure has loaded.
    if (endpoint.capabilities?.includes('ModeController')) {
      const ctrlVent = this.structureCache?.getControl(endpoint.uuid);
      if (ctrlVent?.type === 'Ventilation') {
        const modes = this._resolveVentModeList(endpoint);
        if (modes && modes.length > 0) {
          caps.push({
            type: 'AlexaInterface',
            interface: 'Alexa.ModeController',
            instance: MODE_INSTANCE_VENT_MODE,
            version: PROTO_VERSION,
            properties: {
              supported: [{ name: 'mode' }],
              retrievable: true,
              proactivelyReported: true,
            },
            capabilityResources: {
              friendlyNames: [
                { '@type': 'asset', value: { assetId: 'Alexa.Setting.Mode' } },
                { '@type': 'text',  value: { text: 'Mode',     locale: 'en-US' } },
                { '@type': 'text',  value: { text: 'Modus',    locale: 'de-DE' } },
                { '@type': 'text',  value: { text: 'Betriebsart', locale: 'de-DE' } },
              ],
            },
            configuration: {
              ordered: false,
              supportedModes: modes.map((m) => ({
                value: String(m.id),
                modeResources: {
                  friendlyNames: [
                    { '@type': 'text', value: { text: m.name, locale: 'en-US' } },
                    { '@type': 'text', value: { text: m.name, locale: 'de-DE' } },
                  ],
                },
              })),
            },
          });
        }
      }
    }
    // ACControl fan-speed ModeController. Same shape as audio-source mode
    // controller — slot list with friendlyNames per slot — but instance
    // string differs so directives route correctly. Falls back to default
    // names ("Off", "Auto", "Silent", ...) when the `fanspeeds` state
    // hasn't arrived yet, so Discovery never advertises an empty list.
    if (endpoint.capabilities?.includes('ModeController')) {
      const ctrlAc = this.structureCache?.getControl(endpoint.uuid);
      if (ctrlAc?.type === 'ACControl') {
        const fanSlots = this._resolveACFanSpeedSlots(endpoint) || [];
        if (fanSlots.length > 0) {
          caps.push({
            type: 'AlexaInterface',
            interface: 'Alexa.ModeController',
            instance: MODE_INSTANCE_AC_FAN,
            version: PROTO_VERSION,
            properties: {
              supported: [{ name: 'mode' }],
              retrievable: true,
              proactivelyReported: true,
            },
            capabilityResources: {
              friendlyNames: [
                { '@type': 'text', value: { text: 'Fan Speed',          locale: 'en-US' } },
                { '@type': 'text', value: { text: 'Fan',                locale: 'en-US' } },
                { '@type': 'text', value: { text: 'Lüfter',             locale: 'de-DE' } },
                { '@type': 'text', value: { text: 'Lüftergeschwindigkeit', locale: 'de-DE' } },
              ],
            },
            configuration: {
              ordered: true,    // Off < Auto < Silent < ... < Very High — speed has natural order
              supportedModes: fanSlots.map((s) => ({
                value: String(s.slot),
                modeResources: {
                  friendlyNames: [
                    { '@type': 'text', value: { text: s.name, locale: 'en-US' } },
                    { '@type': 'text', value: { text: s.name, locale: 'de-DE' } },
                  ],
                },
              })),
            },
          });
        }
      }
    }
    // Read-only sensor capabilities. No directives — Alexa never sends
    // commands to a sensor; we just emit ChangeReports and answer
    // ReportState. detectionState ∈ {DETECTED, NOT_DETECTED}; the
    // semantics differ slightly per interface:
    //   MotionSensor: DETECTED = motion detected
    //   ContactSensor: DETECTED = contact present (e.g. door CLOSED)
    if (endpoint.capabilities?.includes('MotionSensor')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.MotionSensor',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'detectionState' }],
          retrievable: true,
          proactivelyReported: true,
        },
      });
    }
    if (endpoint.capabilities?.includes('ContactSensor')) {
      // Alexa.Semantics stateMappings let voice queries like
      // "is the kitchen door open?" answer with natural phrasing instead
      // of literally repeating "detected"/"not detected".
      //
      // Mapping convention (after daemon-side polarity inversion already
      // applied — see polarize()): detectionState=DETECTED → closed,
      // detectionState=NOT_DETECTED → open. This matches Alexa's
      // documented ContactSensor semantic. The mapping holds *regardless*
      // of whether the user inverts polarity; inversion happens on the
      // wire, not in the semantic layer.
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.ContactSensor',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'detectionState' }],
          retrievable: true,
          proactivelyReported: true,
        },
        semantics: {
          stateMappings: [
            {
              '@type': 'StatesToValue',
              states: ['Alexa.States.Closed'],
              value: 'DETECTED',
            },
            {
              '@type': 'StatesToValue',
              states: ['Alexa.States.Open'],
              value: 'NOT_DETECTED',
            },
          ],
        },
      });
    }
    // HumiditySensor — `relativeHumidity` 0..100. Value is reported as an
    // OBJECT { value: N }, unlike MotionSensor/ContactSensor (plain string).
    if (endpoint.capabilities?.includes('HumiditySensor')) {
      caps.push({
        type: 'AlexaInterface',
        interface: 'Alexa.HumiditySensor',
        version: PROTO_VERSION,
        properties: {
          supported: [{ name: 'relativeHumidity' }],
          retrievable: true,
          proactivelyReported: true,
        },
      });
    }
    // EndpointHealth uses the 3.1 schema (not plain 3) — the docs declare
    // connectivity as a 3.1-versioned property. Alexa uses its
    // `connectivity` property to colour the device tile (greyed-out when
    // OFFLINE). proactivelyReported stays false: we'd need to detect
    // Loxone-disconnect / bridge-disconnect events and emit ChangeReports
    // for them, which isn't wired yet — declaring true would lie to Alexa
    // about our update guarantees.
    caps.push({
      type: 'AlexaInterface',
      interface: 'Alexa.EndpointHealth',
      version: '3.1',
      properties: {
        supported: [{ name: 'connectivity' }],
        retrievable: true,
        proactivelyReported: false,
      },
    });
    return caps;
  }

  async _handlePower(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }

    const targetOn = h.name === 'Alexa.PowerController.TurnOn' || h.name === 'TurnOn';
    const powerState = targetOn ? 'ON' : 'OFF';

    // Two endpoint flavours coexist during the transition from step 8 to step 9:
    //
    //   A. Legacy: endpoint.power = { msNo, name, onValue, offValue }
    //      Targets a Virtual Input by name via lox-send.pl.
    //      Kept for backwards compatibility with hardcoded test endpoints
    //      (the "Plugin Test" VI) and any future name-based VIs.
    //
    //   B. UUID: endpoint.uuid + endpoint.msNo
    //      Targets a real Loxone control by uuidAction via lox-control.pl.
    //      This is what devices.json produces.
    //
    // Audio Power mapping — diverges between V1 and V2 because Loxone
    // changed the command vocabulary for AudioZoneV2:
    //
    //   V1 (AudioZone):    `on` → play+power, `off` → silence this speaker
    //   V2 (AudioZoneV2):  `play` → power+resume, `Pause` (capital P!) → silence
    //
    // V2 has NO `off` verb in its documented command set. Sending `off`
    // returns HTTP 200 with `value=off` (URL is reachable) but the firmware
    // doesn't recognize it — silent no-op, same failure mode as the
    // `hsv/H/S/V` slash-syntax bug we hit earlier with ColorPickerV2.
    //
    // For TurnOn we use `play` on both versions: it implies "power on if
    // needed" plus resume-the-source, which matches the "turn on the
    // speaker" user intent better than V1's raw `on` (which fires an
    // immediate playback attempt and gives up if there's no queue).
    //
    // For TurnOff: V1 keeps `off` (silences just THIS speaker, zone-mates
    // keep playing — per the user's explicit Loxone semantic). V2 uses
    // `Pause` (pauses playback on this output). The capital P in `Pause`
    // is documented and unusual; the rest of V2's verbs are lowercase or
    // camelCase. Don't normalize this — Loxone is case-sensitive here.
    let res;
    let command;
    if (endpoint.uuid) {
      const ctrl = this.structureCache?.getControl(endpoint.uuid);
      if (ctrl?.type === 'AudioZoneV2') {
        command = targetOn ? 'play' : 'Pause';
      } else if (ctrl?.type === 'AudioZone') {
        command = targetOn ? 'play' : 'off';
      } else if (ctrl?.type === 'LightController') {
        // v1 LightController documents lowercase `on`/`off` (Loxone v17
        // Structure File p.94): "on" activates scene 9 (All on), "off"
        // activates scene 0 (All off). Capital On/Off is NOT documented
        // for v1 — don't risk it; the wire is case-sensitive on this
        // control family.
        command = targetOn ? 'on' : 'off';
      } else if (ctrl?.type === 'ACControl') {
        // ACControl: lowercase per v17 Structure File p.152. The toggle
        // command exists but we never want that — toggle isn't idempotent
        // (re-sending TurnOn on an already-on AC would turn it off).
        command = targetOn ? 'on' : 'off';
      } else if (ctrl?.type === 'Ventilation') {
        // Ventilation has no on/off command. "TurnOn" = cancel any manual
        // timer and let the block return to its automatic logic.
        // "TurnOff" = start a manual timer at speed 0 for the configured
        // duration. Read the current mode to preserve it in the setTimer
        // call; fall back to mode 0 (first slot) if we can't read.
        if (targetOn) {
          command = 'setTimer/0';
        } else {
          const currentMode = this._resolveVentMode(endpoint) ?? 0;
          const hours = endpoint.ventilationOverrideHours || 24;
          command = this._buildVentSetTimer({ hours, speed: 0, modeId: currentMode });
        }
      } else {
        command = targetOn ? 'On' : 'Off';   // Switch / Light / LightControllerV2: capital
      }
      this.log.debug(
        { endpointId, loxoneUuid: endpoint.uuid, command },
        `${h.name} → Loxone command`,
      );
      res = await this.loxoneCommand.sendByUuid({
        msNo: endpoint.msNo || 1,
        uuid: endpoint.uuid,
        command,
      });
    } else if (endpoint.power) {
      command = `VI ${endpoint.power.name}=${targetOn ? endpoint.power.onValue : endpoint.power.offValue}`;
      this.log.debug(
        { endpointId, viName: endpoint.power.name, value: targetOn ? endpoint.power.onValue : endpoint.power.offValue },
        `${h.name} → Loxone VI command`,
      );
      res = await this.loxoneCommand.send({
        msNo: endpoint.power.msNo,
        name: endpoint.power.name,
        value: targetOn ? endpoint.power.onValue : endpoint.power.offValue,
      });
    } else {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has neither uuid nor power mapping`);
    }

    if (!res.ok) {
      this.log.warn({ endpointId, command, res }, 'Loxone power command failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      `${h.name} → Loxone OK`,
    );

    return powerResponse(h, endpointId, powerState);
  }

  // Handle Alexa.ModeController.SetMode. Dispatch by (control type, instance):
  //   LightControllerV2 + Aloxberry.LightMood → changeTo/<moodId>
  //   AudioZone/V2     + Aloxberry.Audio.Repeat → repeat/<n>
  //   AudioZone        + Aloxberry.Audio.Source → source/<slot>
  //   AudioZoneV2      + Aloxberry.Audio.Source → playZoneFav/<slot>
  //
  // The mode `value` is whatever Discovery advertised — a numeric mood ID
  // for lights, a string ('off'/'all'/'one') for repeat, a numeric slot
  // for source. The handler maps to the right wire format.
  async _handleSetMode(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    const requestedMode = directive.payload?.mode;
    if (typeof requestedMode !== 'string' || requestedMode.length === 0) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing payload.mode');
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }
    const control = this.structureCache?.getControl(endpoint.uuid);

    // Build the right Loxone command per (type, instance) pair.
    let command;
    let responseInstance = h.instance;
    if (control && AUDIO_TYPES.has(control.type) && h.instance === MODE_INSTANCE_REPEAT) {
      const numeric = REPEAT_BY_ALEXA[requestedMode];
      if (numeric === undefined) {
        return errorResponse(h, 'INVALID_VALUE', `Unsupported repeat mode: ${requestedMode}`);
      }
      command = `repeat/${numeric}`;
    } else if (control && AUDIO_TYPES.has(control.type) && h.instance === MODE_INSTANCE_SOURCE) {
      // Source is advertised for V1 AudioZone only (see Discovery). V2 has
      // no favorites surface on the Miniserver, so we never emit the mode
      // for it — reject defensively in case a stale Alexa endpoint cache
      // still sends one rather than firing a blind playZoneFav/<n>.
      if (control.type !== 'AudioZone') {
        return errorResponse(h, 'INVALID_VALUE',
          'Source selection is not available for this audio zone '
          + '(AudioZoneV2 favorites are not exposed by the Loxone API)');
      }
      const slot = Number.parseInt(requestedMode, 10);
      if (!Number.isFinite(slot)) {
        return errorResponse(h, 'INVALID_VALUE', `Unsupported source slot: ${requestedMode}`);
      }
      // V1 AudioZone: source/<slot>, where <slot> is the favorite's stable
      // per-zone slot id from the sourceList `getroomfavs_result.items[]`
      // (NOT a list position — slots are non-contiguous; Structure File
      // p.35).
      command = `source/${slot}`;
      // Debug: the exact mapping Alexa-mode -> Loxone command. `expectedName`
      // is the favorite name we advertised for this slot at Discovery; if the
      // zone plays something else, the slot/id correspondence is wrong (slot
      // index vs. favorite id), not the transport.
      const advertised = this._resolveSourceList(endpoint);
      const match = advertised.find((s) => String(s.slot) === String(slot));
      this.log.debug({
        endpointId,
        uuid: endpoint.uuid,
        controlType: control.type,
        alexaMode: requestedMode,
        parsedSlot: slot,
        expectedName: match ? match.name : null,
        loxoneCommand: command,
      }, `SetMode(Source): Alexa mode "${requestedMode}" -> Loxone jdev/sps/io/${endpoint.uuid}/${command}`);
    } else if (control?.type === 'LightController') {
      // LightController (v1): activates the scene whose number is the
      // raw command — `1`, `2`, `7`, etc. No prefix. Scene 0 = all off,
      // scene 9 = all on (the same special IDs available via `on`/`off`).
      // Discovery only ever advertises numeric scene ids (value:
      // String(m.id)); parse + validate so an Alexa-supplied mode string
      // can't inject extra path segments into the jdev/sps/io/<uuid>/<cmd>
      // URL (e.g. `0/../sys/reboot`).
      const sceneId = Number.parseInt(requestedMode, 10);
      if (!Number.isFinite(sceneId) || sceneId < 0 || String(sceneId) !== requestedMode.trim()) {
        return errorResponse(h, 'INVALID_VALUE', `Unsupported scene: ${requestedMode}`);
      }
      command = String(sceneId);
      responseInstance = MODE_INSTANCE_LIGHT_SCENE;
    } else if (control?.type === 'ACControl' && h.instance === MODE_INSTANCE_AC_FAN) {
      // ACControl fan speed slot 0..N. The slot index matches what
      // Discovery advertised (we generate strings 0,1,...); Loxone's
      // setFan accepts the raw slot.
      const slot = Number.parseInt(requestedMode, 10);
      if (!Number.isFinite(slot) || slot < 0) {
        return errorResponse(h, 'INVALID_VALUE', `Unsupported fan slot: ${requestedMode}`);
      }
      command = `setFan/${slot}`;
      responseInstance = MODE_INSTANCE_AC_FAN;
    } else if (control?.type === 'Ventilation' && h.instance === MODE_INSTANCE_VENT_MODE) {
      // Ventilation mode change. Read-modify-write: preserve current speed.
      // If speed isn't cached, fall back to 50 — a "use a reasonable
      // moderate speed" assumption, since cancelling the timer entirely
      // (setTimer/0) would lose the user's mode choice as the block
      // returns to auto.
      const modeId = Number.parseInt(requestedMode, 10);
      if (!Number.isFinite(modeId)) {
        return errorResponse(h, 'INVALID_VALUE', `Unsupported ventilation mode: ${requestedMode}`);
      }
      const currentSpeed = this._resolveVentSpeed(endpoint) ?? 50;
      const hours = endpoint.ventilationOverrideHours || 24;
      command = this._buildVentSetTimer({ hours, speed: currentSpeed, modeId });
      responseInstance = MODE_INSTANCE_VENT_MODE;
    } else if (control?.type === 'Radio' && h.instance === MODE_INSTANCE_RADIO) {
      // Radio: send the raw output ID, OR "reset" for id=0 (the documented
      // All Off command — sending "0" directly is NOT accepted by the
      // Miniserver, per v17 Structure File p.112: "0 cannot be selected
      // directly, only via `reset`").
      const id = Number.parseInt(requestedMode, 10);
      if (!Number.isFinite(id) || id < 0) {
        return errorResponse(h, 'INVALID_VALUE', `Unsupported radio output: ${requestedMode}`);
      }
      command = id === 0 ? 'reset' : String(id);
      responseInstance = MODE_INSTANCE_RADIO;
    } else if (control?.type === 'Sequential' && h.instance === MODE_INSTANCE_SEQUENCE) {
      // Sequential: `triggerSequence/{id}` activates the program, id=0
      // stops any running sequence (per v17 Structure File p.119). No
      // special-case verb like Radio's `reset` — Loxone uses the same
      // command shape for both start and stop, just with the sentinel.
      const id = Number.parseInt(requestedMode, 10);
      if (!Number.isFinite(id) || id < 0) {
        return errorResponse(h, 'INVALID_VALUE', `Unsupported sequence: ${requestedMode}`);
      }
      command = `triggerSequence/${id}`;
      responseInstance = MODE_INSTANCE_SEQUENCE;
    } else if (h.instance === MODE_INSTANCE_BINARY_SENSOR) {
      // Binary-sensor ModeController is read-only. Alexa users can voice
      // "is my mailbox full?" (works via ReportState) but "set the mailbox
      // to full" doesn't physically correspond to anything. Reject
      // explicitly rather than fall into the default LightControllerV2
      // path (which would send a nonsense `changeTo/N` to a sensor).
      return errorResponse(h, 'INVALID_VALUE',
        'This sensor is read-only — its state cannot be set');
    } else {
      // Default path — LightControllerV2 moods. Discovery advertises only
      // numeric mood ids (value: String(m.id)), so a valid mode is always
      // a non-negative integer. Parse + validate before interpolating into
      // changeTo/<id>; without this an Alexa-supplied mode like
      // `0/../sys/reboot` would inject extra path segments into the
      // authenticated jdev/sps/io/<uuid>/<cmd> request.
      const moodId = Number.parseInt(requestedMode, 10);
      if (!Number.isFinite(moodId) || moodId < 0 || String(moodId) !== requestedMode.trim()) {
        return errorResponse(h, 'INVALID_VALUE', `Unsupported mood: ${requestedMode}`);
      }
      command = `changeTo/${moodId}`;
      responseInstance = MODE_INSTANCE;
    }

    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, requestedMode, command, res }, 'Loxone SetMode failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    if (control && AUDIO_TYPES.has(control.type) && h.instance === MODE_INSTANCE_SOURCE) {
      // Debug: Miniserver accepted the favorite command. `stdout` is the
      // raw Loxone webservice reply (LL.value). If this says it succeeded
      // but the wrong favorite plays, the slot->id mapping is the culprit,
      // not the transport — cross-check against the Discovery mode list.
      this.log.debug({
        endpointId,
        uuid: endpoint.uuid,
        controlType: control.type,
        loxoneCommand: command,
        loxoneReply: res.stdout,
        durationMs: res.durationMs,
      }, `SetMode(Source): Loxone accepted ${command}`);
    }

    // For LightControllerV2 only: also echo a derived powerState (OFF iff
    // the All-Off mood was just selected). Audio doesn't have an analogous
    // derived state — the user's audio power is independent of the
    // repeat/source mode and managed via PowerController directly.
    const props = [{
      namespace: 'Alexa.ModeController',
      instance:  responseInstance,
      name:      'mode',
      value:     requestedMode,
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    }];
    if (control?.type === 'LightControllerV2') {
      props.push({
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        value: Number(requestedMode) === OFF_MOOD_ID ? 'OFF' : 'ON',
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 500,
      });
    }
    if (control?.type === 'LightController') {
      // v1's "all off" is the hard-coded scene 0 — derive powerState the
      // same way LCV2 does, just with the v1 sentinel.
      props.push({
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        value: Number(requestedMode) === OFF_SCENE_ID ? 'OFF' : 'ON',
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 500,
      });
    }

    return {
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: h.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
      context: { properties: props },
    };
  }

  // Handle Alexa.ModeController.AdjustMode. The directive carries a signed
  // modeDelta (e.g. +1, +2); Loxone has `plus` / `minus` to step through
  // moods one at a time. v1 ignores |delta| > 1 — most "next/previous mood"
  // voice phrasings land as ±1 anyway. Document upgrade path: loop the
  // command modeDelta times.
  async _handleAdjustMode(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    const delta = Number(directive.payload?.modeDelta);
    if (!Number.isFinite(delta) || delta === 0) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid modeDelta');
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }

    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command: delta > 0 ? 'plus' : 'minus',
    });
    if (!res.ok) {
      this.log.warn({ endpointId, delta, res }, 'Loxone plus/minus failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone plus/minus failed: ${res.category} ${res.stderr || ''}`.trim());
    }

    // Don't echo a context property — we don't know what mood Loxone just
    // landed on (depends on the current activeMoods + mood order). The
    // proactive ChangeReport from state-reporter fills Alexa in seconds later.
    return {
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: h.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
    };
  }

  // ----- ColorPickerV2 handlers ----------------------------------------

  // SetBrightness / AdjustBrightness. The same Loxone command is composed
  // either as `hsv(H,S,V)` or `temp(B,K)` — we preserve whichever dimension
  // (color or kelvin) the device currently sits at. Relative form takes the
  // current brightness and adds `brightnessDelta`.
  async _handleSetBrightness(directive, relative) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }

    // Compute the target brightness (0..100) once — same for every control
    // type. For relative (AdjustBrightness) we need the live base; resolve
    // it from whichever state the endpoint actually has.
    const dimmerState = this._resolveDimmerState(endpoint);
    const current = dimmerState || this._resolveColorPickerState(endpoint);
    let target;
    if (relative) {
      const delta = Number(directive.payload?.brightnessDelta);
      if (!Number.isFinite(delta)) {
        return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid brightnessDelta');
      }
      const base = (current?.brightness ?? 0);
      target = clamp(Math.round(base + delta), 0, 100);
    } else {
      const requested = Number(directive.payload?.brightness);
      if (!Number.isFinite(requested)) {
        return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid brightness');
      }
      target = clamp(Math.round(requested), 0, 100);
    }

    // Plain Dimmer: native `{pos}` grammar (Structure File V17 p.59), NOT
    // the ColorPickerV2 hsv()/temp() grammar below — a Dimmer doesn't
    // understand those. Map Alexa 0..100 onto the control's live [min,max];
    // brightness 0 sends `off` (Loxone's documented "position 0" semantics)
    // so a min>0 dimmer still actually turns off instead of resting at min.
    const ctrl = this.structureCache?.getControl(endpoint.uuid);
    if (ctrl?.type === 'Dimmer') {
      const pos = brightnessToDimmer(target, dimmerState?.min, dimmerState?.max);
      const command = target === 0 ? 'off' : String(pos);
      this.log.debug(
        { endpointId, loxoneUuid: endpoint.uuid, command, targetBrightness: target, pos },
        `${h.name} → Loxone Dimmer command`,
      );
      const dres = await this.loxoneCommand.sendByUuid({
        msNo: endpoint.msNo || 1,
        uuid: endpoint.uuid,
        command,
      });
      if (!dres.ok) {
        this.log.warn({ endpointId, command, res: dres }, 'Loxone Dimmer brightness command failed');
        return errorResponse(h, 'ENDPOINT_UNREACHABLE',
          `Loxone command failed: ${dres.category} ${dres.stderr || ''}`.trim());
      }
      return this._colorPickerResponse(h, endpointId, {
        brightness: target,
        powerState: target === 0 ? 'OFF' : 'ON',
        color: null,
        colorTemperatureInKelvin: null,
      });
    }

    // Build the right Loxone command based on the device's current mode.
    // Falls back to temp at a neutral kelvin when state isn't cached yet.
    let command;
    let echoColor = null;
    let echoKelvin = null;
    if (current?.mode === 'hsv') {
      command = `hsv(${current.hue},${current.saturation},${target})`;
      echoColor = {
        hue:        current.hue,
        saturation: current.saturation / 100,
        brightness: target / 100,
      };
    } else if (current?.mode === 'temp') {
      command = `temp(${target},${current.kelvin})`;
      echoKelvin = current.kelvin;
    } else {
      command = `temp(${target},${CT_NEUTRAL_K})`;
      echoKelvin = CT_NEUTRAL_K;
    }

    this.log.debug(
      { endpointId, loxoneUuid: endpoint.uuid, command, currentState: current, targetBrightness: target },
      'SetBrightness → Loxone command',
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, command, res }, 'Loxone brightness command failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      'SetBrightness → Loxone OK',
    );

    return this._colorPickerResponse(h, endpointId, {
      brightness: target,
      powerState: target === 0 ? 'OFF' : 'ON',
      color:                    echoColor,
      colorTemperatureInKelvin: echoKelvin,
    });
  }

  // SetColor. Always switches Loxone to HSV mode. Alexa hue is 0-360 (deg),
  // saturation + brightness are 0-1; Loxone wants 0-100 for s/v.
  async _handleSetColor(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }
    const color = directive.payload?.color;
    const hue   = Number(color?.hue);
    const sat   = Number(color?.saturation);
    const bri   = Number(color?.brightness);
    if (!Number.isFinite(hue) || !Number.isFinite(sat) || !Number.isFinite(bri)) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid color payload');
    }
    const hueRounded = clamp(Math.round(hue), 0, 360);
    const satPct     = clamp(Math.round(sat * 100), 0, 100);
    const briPct     = clamp(Math.round(bri * 100), 0, 100);

    const command = `hsv(${hueRounded},${satPct},${briPct})`;
    this.log.debug(
      { endpointId, loxoneUuid: endpoint.uuid, command, hue: hueRounded, sat: satPct, bri: briPct },
      'SetColor → Loxone command',
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, res }, 'Loxone hsv command failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      'SetColor → Loxone OK',
    );

    return this._colorPickerResponse(h, endpointId, {
      brightness: briPct,
      powerState: briPct === 0 ? 'OFF' : 'ON',
      color: { hue: hueRounded, saturation: satPct / 100, brightness: briPct / 100 },
    });
  }

  // SetColorTemperature. Alexa hands a kelvin value; we keep brightness as-is
  // (defaulting to 100 when current is 0 — "make it warmer" while off should
  // implicitly turn the light on at full).
  async _handleSetColorTemperature(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }
    const k = Number(directive.payload?.colorTemperatureInKelvin);
    if (!Number.isFinite(k)) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid colorTemperatureInKelvin');
    }
    const kClamped = clamp(Math.round(k), CT_MIN_K, CT_MAX_K);
    const current  = this._resolveColorPickerState(endpoint);
    const brightness = (current?.brightness && current.brightness > 0)
      ? current.brightness
      : CT_DEFAULT_BRIGHTNESS;

    const command = `temp(${brightness},${kClamped})`;
    this.log.debug(
      { endpointId, loxoneUuid: endpoint.uuid, command, currentState: current, requestedK: kClamped, brightness },
      'SetColorTemperature → Loxone command',
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, res }, 'Loxone temp command failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      'SetColorTemperature → Loxone OK',
    );

    return this._colorPickerResponse(h, endpointId, {
      brightness,
      powerState: 'ON',
      colorTemperatureInKelvin: kClamped,
    });
  }

  // IncreaseColorTemperature / DecreaseColorTemperature. Read current K
  // from the state cache, add the step (signed), clamp, send temp/B/K.
  async _handleStepColorTemperature(directive, stepK) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }
    const current = this._resolveColorPickerState(endpoint);
    const baseK = (current?.mode === 'temp' && current.kelvin) ? current.kelvin : CT_NEUTRAL_K;
    const newK = clamp(baseK + stepK, CT_MIN_K, CT_MAX_K);
    const brightness = (current?.brightness && current.brightness > 0)
      ? current.brightness
      : CT_DEFAULT_BRIGHTNESS;

    const command = `temp(${brightness},${newK})`;
    this.log.debug(
      { endpointId, loxoneUuid: endpoint.uuid, command, currentState: current, stepK, newK, brightness },
      'StepColorTemperature → Loxone command',
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, res }, 'Loxone temp step command failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      'StepColorTemperature → Loxone OK',
    );

    return this._colorPickerResponse(h, endpointId, {
      brightness,
      powerState: 'ON',
      colorTemperatureInKelvin: newK,
    });
  }

  // ----- RangeController handlers --------------------------------------

  // SetRangeValue / AdjustRangeValue. One handler covers four Loxone types
  // (Jalousie, Window, Gate, Slider). The dispatch separates two concerns:
  //
  //   1. The Alexa-side scale and the axis-inversion flag are uniform across
  //      types — driven by control.type for the bounds and by the device's
  //      `rangeAxisInverted` flag for the inversion. Both are funneled into
  //      a single `loxoneTarget` number.
  //   2. The wire-format dispatch picks the Loxone command verb. This is
  //      the only place control.type matters at write time.
  //
  // Slider speaks its own native range (degrees, percent, whatever the
  // user configured); blind-shaped types are always 0..100 Alexa-space.
  // `rangeAxisInverted` defaults from the type but is overridable per-device.
  async _handleSetRangeValue(directive, relative) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }
    const control = this.structureCache?.getControl(endpoint.uuid);
    if (!control) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no matching Loxone control`);
    }
    // Bounds source depends on the control type. Most types read from
    // structure-level config (rangeBoundsFor). ValueSelector reads from
    // live state, so its bounds can shift between directives. Read at
    // directive time so a logic-driven bound change immediately affects
    // clamping (no stale bound carried over from Discovery).
    const bounds = control.type === 'ValueSelector'
      ? this._resolveValueSelectorBounds(endpoint)
      : rangeBoundsFor(control);

    let target;  // Alexa-space (what the user thinks of as the value)
    if (relative) {
      const delta = Number(directive.payload?.rangeValueDelta);
      if (!Number.isFinite(delta)) {
        return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid rangeValueDelta');
      }
      // ValueSelector "+ only" variant: reject negative deltas at the
      // dispatch boundary. The "−" button doesn't exist on this physical
      // control type in Loxone Config, so honoring the directive would
      // either silently no-op or fight the user's expectation.
      if (control.type === 'ValueSelector'
          && control.details?.increaseOnly === true
          && delta < 0) {
        return errorResponse(h, 'INVALID_VALUE',
          'This ValueSelector is increase-only; negative adjustments are not allowed');
      }
      // Cold-cache fallback: for blind-shaped, assume "open" (max) so
      // "close a bit" still moves toward closed. For Slider/ValueSelector,
      // fall back to min — generic value-shaped controls have no natural
      // "all the way up" assumption.
      const fallback = BLIND_TYPES.has(control.type) ? bounds.max : bounds.min;
      const current = this._resolveRangeValue(endpoint) ?? fallback;
      target = clamp(current + delta, bounds.min, bounds.max);
    } else {
      const requested = Number(directive.payload?.rangeValue);
      if (!Number.isFinite(requested)) {
        return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid rangeValue');
      }
      target = clamp(requested, bounds.min, bounds.max);
    }
    // Quantize to step where applicable. Slider keeps native precision
    // from its own step field; ValueSelector quantizes to its (state-
    // driven) step; everything else rounds to integers.
    if (control.type === 'Slider') {
      // No additional rounding — Slider precision matches bounds.step from details.
    } else if (control.type === 'ValueSelector' && bounds.step > 0) {
      // Snap to the nearest step boundary, anchored at bounds.min so the
      // grid lines up with Loxone's own +/- presses.
      const steps = Math.round((target - bounds.min) / bounds.step);
      target = bounds.min + steps * bounds.step;
      // Re-clamp post-round; a step-snap near max can edge over.
      target = clamp(target, bounds.min, bounds.max);
    } else {
      target = Math.round(target);
    }

    // Apply the device-level axis flag. From here on, `loxoneTarget` is
    // the value we'll embed in the wire command (still numeric, still
    // bounds-clamped — only its meaning shifted).
    const axisInverted = !!endpoint.rangeAxisInverted;
    const loxoneTarget = axisInverted ? mirrorInRange(target, bounds) : target;

    // Per-type wire format. This is the only switch over control.type in
    // the write path — every other consideration (scale, inversion, fallback)
    // is type-agnostic above.
    let command;
    switch (control.type) {
      case 'Jalousie':
        command = `ManualPosition/${loxoneTarget}`;
        break;
      case 'Window':
        command = `moveToPosition/${loxoneTarget}`;
        break;
      case 'Gate':
        // Gate has no continuous-position command. Snap the user's request
        // to one of three verbs the Miniserver accepts. Use the post-axis-
        // inversion `loxoneTarget` so a user with axis-flipped Gate gets
        // consistent open/close semantics.
        if (loxoneTarget <= 0)        command = 'close';
        else if (loxoneTarget >= 100) command = 'open';
        else                          command = 'PartiallyOpen';
        break;
      case 'Slider':
        command = String(loxoneTarget);
        break;
      case 'ValueSelector':
        // Same wire format as Slider: send the raw value. Difference is
        // purely upstream (bounds source, increaseOnly enforcement).
        command = String(loxoneTarget);
        break;
      case 'Ventilation': {
        // Read-modify-write: preserve the current mode (Loxone has no
        // "set speed only" command — every setTimer call resets all four
        // params). If no mode cached, fall back to 0 (first mode in
        // details.modes); a fresh install will hit this until the block
        // reports state.
        const currentMode = this._resolveVentMode(endpoint) ?? 0;
        const hours = endpoint.ventilationOverrideHours || 24;
        command = this._buildVentSetTimer({ hours, speed: loxoneTarget, modeId: currentMode });
        break;
      }
      default:
        return errorResponse(h, 'INVALID_DIRECTIVE',
          `RangeController not supported for Loxone type ${control.type}`);
    }

    this.log.debug(
      { endpointId, loxoneUuid: endpoint.uuid, command, relative,
        controlType: control.type, axisInverted,
        rangeValue: target, loxoneTarget, bounds },
      `${h.name} → Loxone command`,
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, command, res }, 'Loxone RangeController write failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      `${h.name} → Loxone OK`,
    );

    return this._rangeResponse(h, endpointId, target, control.type);
  }

  // Resolve the current RangeController value for any of our supported
  // Loxone types and return it in Alexa-space (after any axis inversion).
  // Returns null when state is missing — callers fall back to a sane
  // default or omit the property from ReportState.
  _resolveRangeValue(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control) return null;

    // Read the raw numeric state from the type's "current value" UUID.
    let raw;
    if (control.type === 'Slider') {
      // Slider's `value` state event is the literal slider value already
      // in native range — no scaling required.
      const uuid = control.states?.value;
      if (!uuid) return null;
      const entry = this.stateCache.getValue(uuid);
      if (!entry || !Number.isFinite(entry.value)) return null;
      raw = entry.value;
    } else if (BLIND_TYPES.has(control.type)) {
      // All three blind-shaped types use a 0..1 `position` state. We
      // scale to 0..100 (Alexa's blind scale) before applying axis.
      const uuid = control.states?.position;
      if (!uuid) return null;
      const entry = this.stateCache.getValue(uuid);
      if (!entry || !Number.isFinite(entry.value)) return null;
      raw = clamp(Math.round(entry.value * 100), 0, 100);
    } else if (control.type === 'Ventilation') {
      // Ventilation's `speed` state is already in Alexa-space (0..100%).
      // No axis inversion applies to fan speed — 0 always means off,
      // 100 always means full.
      return this._resolveVentSpeed(endpoint);
    } else if (control.type === 'ValueSelector') {
      // ValueSelector: native value in its own bounds; no inversion,
      // no scaling. Caller decides whether to compare against bounds.
      return this._resolveValueSelectorValue(endpoint);
    } else {
      return null;
    }

    const bounds = rangeBoundsFor(control);
    const axisInverted = !!endpoint.rangeAxisInverted;
    return axisInverted ? mirrorInRange(raw, bounds) : raw;
  }

  // Pick the right RangeController instance for the directive response.
  // Must match what Discovery advertised for the same endpoint, otherwise
  // Alexa silently drops the property update.
  _rangeInstanceFor(controlType) {
    if (controlType === 'Slider')        return RANGE_INSTANCE_SLIDER;
    if (controlType === 'Ventilation')   return RANGE_INSTANCE_VENT_SPEED;
    if (controlType === 'ValueSelector') return RANGE_INSTANCE_VALUE_SELECTOR;
    return RANGE_INSTANCE_BLINDS;
  }

  // Build the standard "directive done" response for RangeController.
  // Echoes the applied rangeValue back so Alexa's UI updates immediately
  // (a few hundred ms before the proactive ChangeReport lands).
  _rangeResponse(directiveHeader, endpointId, rangeValue, controlType) {
    const properties = [{
      namespace: 'Alexa.RangeController',
      instance:  this._rangeInstanceFor(controlType),
      name:      'rangeValue',
      value:     rangeValue,
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    }];
    return {
      context: { properties },
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: directiveHeader.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
    };
  }

  // ----- SceneController handler ---------------------------------------

  // Alexa.SceneController.Activate for Loxone Pushbutton (and any other
  // Loxone type whose semantics are "fire a momentary pulse"). One verb,
  // one response shape, no state to track — the simplest skill in v1.
  //
  // The activation cause carries voice/app provenance forward into Alexa's
  // routine history. We pass it through verbatim from the directive
  // payload; absence defaults to APP_INTERACTION (Alexa's documented
  // fallback when the directive omits it — typically a UI trigger).
  async _handleSceneActivate(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }

    // Pulse is Loxone's "momentary press" verb on a Pushbutton uuidAction
    // — fires the Loxone program logic wired behind the button. Same
    // wire-format pattern as PowerController On/Off (single token at the
    // end of the URL path).
    const command = 'Pulse';
    this.log.debug(
      { endpointId, loxoneUuid: endpoint.uuid, command },
      'SceneController.Activate → Loxone command',
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, command, res }, 'Loxone Pulse failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      'SceneController.Activate → Loxone OK',
    );

    // Cause: Alexa's spec enumerates VOICE_INTERACTION, APP_INTERACTION,
    // and PHYSICAL_INTERACTION. We accept whatever cause the directive
    // payload supplied — Alexa typically sets it correctly — and default
    // to APP_INTERACTION when missing, which is the safest "we don't know
    // exactly who pressed this" attribution.
    const cause = directive.payload?.cause?.type || 'APP_INTERACTION';
    return {
      context: {},
      event: {
        header: header('Alexa.SceneController', 'ActivationStarted', PROTO_VERSION, {
          correlationToken: h.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {
          cause: { type: cause },
          timestamp: nowIso(),
        },
      },
    };
  }

  // ----- ThermostatController handlers ---------------------------------

  // SetTargetTemperature / AdjustTargetTemperature. One handler covers
  // both: absolute reads payload.targetSetpoint, relative reads
  // payload.targetSetpointDelta and adds to the current cached target.
  //
  // The Loxone write path depends on the endpoint's `thermostatUseOverride`
  // flag (set in the picker). True → `override/3/<until>/<temp>` for a
  // timed override that auto-expires; false → `setComfortTemperature/<n>`
  // which permanently changes the schedule's heating comfort value.
  // modeId=3 = Manual (Loxone allows specifying a temp with this mode).
  //
  // Loxone's increase/decrease verbs aren't used here because they don't
  // honor the override-mode preference — we always read-modify-write
  // through the unified path so both directives have consistent semantics.
  async _handleSetTargetTemperature(directive, relative) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }
    const control = this.structureCache?.getControl(endpoint.uuid);
    const isIRC = control?.type === 'IRoomControllerV2';
    const isAC  = control?.type === 'ACControl';
    if (!isIRC && !isAC) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} is not a thermostat`);
    }
    const scale = thermostatScaleFor(control);

    // Bounds: AC has device-reported minTemp/maxTemp; IRC uses the static
    // TSTAT envelope. Used for the post-clamp before sending to Loxone.
    const bounds = isAC
      ? this._resolveACTempBounds(endpoint)
      : { min: TSTAT_MIN_C, max: TSTAT_MAX_C };

    let targetTemp;
    if (relative) {
      // payload.targetSetpointDelta = { value, scale }. Alexa promises the
      // scale matches what we advertised in Discovery — assume agreement.
      const delta = Number(directive.payload?.targetSetpointDelta?.value);
      if (!Number.isFinite(delta)) {
        return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid targetSetpointDelta');
      }
      const current = isAC
        ? this._resolveACTargetTemperature(endpoint)
        : this._resolveTargetSetpoint(endpoint);
      if (current == null) {
        return errorResponse(h, 'INVALID_VALUE',
          'Cannot adjust target — no current setpoint cached yet');
      }
      targetTemp = current + delta;
    } else {
      const requested = Number(directive.payload?.targetSetpoint?.value);
      if (!Number.isFinite(requested)) {
        return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid targetSetpoint');
      }
      targetTemp = requested;
    }
    // Clamp to the device-reported (AC) or generic (IRC) envelope.
    targetTemp = clamp(targetTemp, bounds.min, bounds.max);
    // Round to 0.5° — Loxone's typical comfort-temp granularity. Avoids
    // sending 22.345617 from a floating-point delta and getting echoed
    // back identically (which would churn cached comparisons).
    const rounded = Math.round(targetTemp * 2) / 2;

    // Pick the wire command per control type:
    //   ACControl     → setTarget/<temp> (always permanent — there's no
    //                   override-vs-permanent distinction documented for AC)
    //   IRoomControllerV2 → setComfortTemperature OR override/3/<until>/<temp>
    //                       depending on the per-device thermostatUseOverride flag
    let command;
    if (isAC) {
      command = `setTarget/${rounded}`;
    } else if (endpoint.thermostatUseOverride && endpoint.thermostatOverrideHours > 0) {
      const untilUnix = Math.floor(Date.now() / 1000) + endpoint.thermostatOverrideHours * 3600;
      const untilLoxone = unixToLoxoneSeconds(untilUnix);
      // Loxone override modeId 3 = Manual, the only mode that accepts a
      // specific temperature in the override command.
      command = `override/3/${untilLoxone}/${rounded}`;
    } else {
      command = `setComfortTemperature/${rounded}`;
    }

    this.log.debug(
      { endpointId, loxoneUuid: endpoint.uuid, command, relative,
        targetTemp: rounded, useOverride: !!endpoint.thermostatUseOverride,
        overrideHours: endpoint.thermostatOverrideHours },
      `${h.name} → Loxone command`,
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, command, res }, 'Loxone thermostat write failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      `${h.name} → Loxone OK`,
    );

    return {
      context: {
        properties: [{
          namespace: 'Alexa.ThermostatController',
          name: 'targetSetpoint',
          value: { value: rounded, scale },
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 500,
        }],
      },
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: h.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
    };
  }

  // SetThermostatMode. Routes the Alexa mode (AUTO/HEAT/COOL/OFF) to
  // Loxone's setOperatingMode with the corresponding numeric ID. We always
  // use the Auto variants (0/1/2) rather than Manual (3/4/5) — keeps the
  // user's mode choice round-trippable through state reads, since reads
  // collapse Manual → Auto anyway.
  async _handleSetThermostatMode(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }
    if (!endpoint.uuid) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Endpoint ${endpointId} has no uuid mapping`);
    }
    const requested = directive.payload?.thermostatMode?.value;
    const control = this.structureCache?.getControl(endpoint.uuid);
    const isAC = control?.type === 'ACControl';
    // Two dispatch shapes by control type. AC uses setMode/<1..3> for the
    // three supported modes (and rejects OFF — that's PowerController's
    // job since AC has no off-as-mode). IRC uses setOperatingMode/<id>
    // mapped via the LOXONE_OPMODE_BY_ALEXA table.
    let command;
    if (isAC) {
      if (requested === 'OFF') {
        // Caller asked us to put an AC into OFF mode — Alexa doesn't know
        // ACs don't have "off mode", they have a power switch. Be helpful
        // and route through the power off command instead.
        const res = await this._sendUuidCommand(endpoint, 'off', h);
        if (!res.ok) return res.errorResponse;
        return {
          context: {
            properties: [{
              namespace: 'Alexa.PowerController',
              name: 'powerState',
              value: 'OFF',
              timeOfSample: nowIso(),
              uncertaintyInMilliseconds: 500,
            }],
          },
          event: {
            header: header('Alexa', 'Response', PROTO_VERSION, {
              correlationToken: h.correlationToken,
            }),
            endpoint: { endpointId },
            payload: {},
          },
        };
      }
      const n = LOXONE_AC_MODE_BY_ALEXA[requested];
      if (n === undefined) {
        return errorResponse(h, 'INVALID_VALUE',
          `Unsupported AC mode: ${requested} (try AUTO/HEAT/COOL/OFF)`);
      }
      command = `setMode/${n}`;
    } else {
      const loxoneMode = LOXONE_OPMODE_BY_ALEXA[requested];
      if (loxoneMode === undefined) {
        return errorResponse(h, 'INVALID_VALUE',
          `Unsupported thermostat mode: ${requested}`);
      }
      command = `setOperatingMode/${loxoneMode}`;
    }
    this.log.debug(
      { endpointId, loxoneUuid: endpoint.uuid, command, requested },
      'SetThermostatMode → Loxone command',
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId, command, res }, 'Loxone setOperatingMode failed');
      return errorResponse(h, 'ENDPOINT_UNREACHABLE',
        `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim());
    }
    this.log.debug(
      { endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      'SetThermostatMode → Loxone OK',
    );

    return {
      context: {
        properties: [{
          namespace: 'Alexa.ThermostatController',
          name: 'thermostatMode',
          value: requested,
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 500,
        }],
      },
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: h.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
    };
  }

  // Resolve the current target setpoint (tempTarget) from the state cache.
  // Null when unreachable — caller decides whether to omit the property
  // (ReportState) or reject the directive (AdjustTargetTemperature on a
  // cold cache, which has no sensible baseline to add a delta to).
  _resolveTargetSetpoint(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'IRoomControllerV2') return null;
    const uuid = control.states?.tempTarget;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? entry.value : null;
  }

  // Resolve the current measured temperature (tempActual). Same gating as
  // _resolveTargetSetpoint; nullable.
  _resolveTempActual(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'IRoomControllerV2') return null;
    const uuid = control.states?.tempActual;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? entry.value : null;
  }

  // ----- ACControl state resolvers ----------------------------------------
  // ACControl exposes its temperature/setpoint under different state names
  // than IRoomControllerV2 (`temperature` / `targetTemperature` vs
  // `tempActual` / `tempTarget`). Separate resolvers keep the dispatch
  // free of per-type branching in the consumers.

  _resolveACTargetTemperature(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ACControl') return null;
    const uuid = control.states?.targetTemperature;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? entry.value : null;
  }

  _resolveACTemperature(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ACControl') return null;
    const uuid = control.states?.temperature;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? entry.value : null;
  }

  // ACControl operating mode → Alexa thermostatMode. Returns null for
  // Loxone modes 4/5 (Dry/Fan) — caller omits the property.
  _resolveACMode(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ACControl') return null;
    const uuid = control.states?.mode;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return alexaModeFromAC(entry.value);
  }

  // ACControl power state (status state, 0/1).
  _resolveACPower(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ACControl') return null;
    const uuid = control.states?.status;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return entry.value !== 0 ? 'ON' : 'OFF';
  }

  // Switch / TimedSwitch live power. Mirrors the state-reporter mapping
  // (Number(value)===0 → OFF, else ON — TimedSwitch can report a non-1
  // numeric mid-countdown, which still means "on"). Without this, ReportState
  // stubbed these to OFF, so Alexa showed wrong state after Discovery until
  // the first real toggle pushed a ChangeReport. Returns 'ON'/'OFF' or null
  // if the state hasn't arrived from the Miniserver yet.
  _resolveSwitchPower(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || (control.type !== 'Switch' && control.type !== 'TimedSwitch')) return null;
    const uuid = control.states?.active;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return Number(entry.value) === 0 ? 'OFF' : 'ON';
  }

  // Live Dimmer state → { brightness 0..100, powerState, min, max }. Reads
  // `position` (the brightness in native [min,max]) plus the live `min`/`max`
  // states (Structure File V17 p.59); min/max default to 0/100 when the
  // Miniserver hasn't pushed them yet. powerState is OFF iff position is
  // exactly 0 — Loxone's own `off` semantics ("sets position to 0"). Returns
  // null for non-Dimmers or before the position state has arrived (callers
  // then omit the property rather than fabricate one).
  _resolveDimmerState(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Dimmer') return null;
    const posUuid = control.states?.position;
    if (!posUuid) return null;
    const posEntry = this.stateCache.getValue(posUuid);
    if (!posEntry || !Number.isFinite(posEntry.value)) return null;
    const readNum = (stateUuid) => {
      const e = stateUuid ? this.stateCache.getValue(stateUuid) : null;
      return (e && Number.isFinite(e.value)) ? e.value : undefined;
    };
    const min = readNum(control.states?.min);
    const max = readNum(control.states?.max);
    const position = posEntry.value;
    return {
      brightness: dimmerToBrightness(position, min, max),
      powerState: position === 0 ? 'OFF' : 'ON',
      min, max,
    };
  }

  // Current fan speed slot. Returns the stringified numeric slot index
  // (matches the values declared in Discovery's supportedModes), or null.
  _resolveACFan(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ACControl') return null;
    const uuid = control.states?.fan;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return String(Math.trunc(entry.value));
  }

  // Parse the `fanspeeds` text state into a [{slot, name}] list. Loxone
  // documents this as a JSON array of strings (per-slot names); fall back
  // to the documented defaults if the state hasn't arrived yet or
  // doesn't parse — Discovery would otherwise advertise no fan modes,
  // dropping the controller entirely.
  _resolveACFanSpeedSlots(endpoint) {
    const DEFAULT_NAMES = [
      'Off', 'Auto', 'Silent', 'Very Low', 'Low', 'Medium', 'High', 'Very High',
    ];
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) {
      return DEFAULT_NAMES.map((name, slot) => ({ slot, name }));
    }
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ACControl') return null;
    const uuid = control.states?.fanspeeds;
    if (uuid) {
      const entry = this.stateCache.getText(uuid);
      if (entry && entry.text) {
        try {
          const parsed = JSON.parse(entry.text);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed
              .map((n, slot) => ({ slot, name: typeof n === 'string' && n.trim() ? n.trim() : DEFAULT_NAMES[slot] || `Speed ${slot}` }));
          }
        } catch { /* fall through to defaults */ }
      }
    }
    return DEFAULT_NAMES.map((name, slot) => ({ slot, name }));
  }

  // Resolve target-temperature bounds from minTemp/maxTemp states. Falls
  // back to the generic TSTAT_MIN_C..TSTAT_MAX_C envelope (5..35 °C) when
  // the device hasn't reported its bounds yet — better than declaring no
  // range at all, which Alexa would interpret as "unbounded".
  _resolveACTempBounds(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) {
      return { min: TSTAT_MIN_C, max: TSTAT_MAX_C };
    }
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ACControl') {
      return { min: TSTAT_MIN_C, max: TSTAT_MAX_C };
    }
    const readState = (name) => {
      const uuid = control.states?.[name];
      if (!uuid) return null;
      const entry = this.stateCache.getValue(uuid);
      return (entry && Number.isFinite(entry.value)) ? entry.value : null;
    };
    const min = readState('minTemp');
    const max = readState('maxTemp');
    return {
      min: min != null ? min : TSTAT_MIN_C,
      max: max != null ? max : TSTAT_MAX_C,
    };
  }

  // ----- Ventilation state resolvers --------------------------------------
  // Ventilation has a quirk: there's no "set speed" command — every write
  // goes through setTimer with all four parameters. The resolvers below
  // give the handler enough current state to fill in the params it isn't
  // changing (e.g., a speed change preserves the current mode).

  _resolveVentSpeed(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Ventilation') return null;
    const uuid = control.states?.speed;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return clamp(Math.round(entry.value), 0, 100);
  }

  _resolveVentMode(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Ventilation') return null;
    const uuid = control.states?.mode;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return Math.trunc(entry.value);
  }

  // activeTimerProfile state — -1 = manual, -2 = no timer, -3 = settings
  // change. Used together with speed to derive PowerController.powerState.
  _resolveVentTimerProfile(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Ventilation') return null;
    const uuid = control.states?.activeTimerProfile;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return Math.trunc(entry.value);
  }

  // Parse available modes from `details.modes` — a JSON array of
  // {name, id} pairs. Each install can configure its own mode names
  // (Heat Exchanger / Exhaust / Bypass / etc.). The list lives in the
  // STRUCTURE (not the state cache) — it's defined at Loxone Config
  // time, not changed at runtime — so it's always available once the
  // structure has loaded, even on cold state cache.
  _resolveVentModeList(endpoint) {
    if (!this.structureCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Ventilation') return null;
    const modes = control.details?.modes;
    if (!Array.isArray(modes) || modes.length === 0) return null;
    const out = [];
    for (const m of modes) {
      if (!m || typeof m !== 'object') continue;
      const id = (typeof m.id === 'number') ? m.id : Number.parseInt(m.id, 10);
      if (!Number.isFinite(id)) continue;
      const name = (typeof m.name === 'string' && m.name.trim().length > 0)
        ? m.name.trim()
        : `Mode ${id}`;
      out.push({ id, name });
    }
    return out.length > 0 ? out : null;
  }

  _resolveVentTemperature(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Ventilation') return null;
    const uuid = control.states?.temperatureIndoor;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? entry.value : null;
  }

  _resolveVentHumidity(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Ventilation') return null;
    const uuid = control.states?.humidityIndoor;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? entry.value : null;
  }

  // Build a setTimer command string. Loxone wants four positional params:
  // {interval-in-seconds}/{speed-percent}/{modeId}/{timerProfileIdx}.
  // We always use timerProfileIdx=-1 (manual) because Alexa users don't
  // see Loxone's named timer profiles (Resting, etc.) — those are
  // configured per-install in Loxone Config and have no equivalent in
  // Alexa's directive vocabulary.
  _buildVentSetTimer({ hours, speed, modeId }) {
    const intervalSec = Math.max(1, Math.round(hours * 3600));
    const clampedSpeed = clamp(Math.round(speed), 0, 100);
    return `setTimer/${intervalSec}/${clampedSpeed}/${modeId}/${VENT_TIMER_PROFILE_MANUAL}`;
  }

  // ----- Radio + ValueSelector state resolvers ----------------------------

  // Radio output list — [{id, name}] sorted by id. Built from the
  // control's `details.outputs` map (a {id -> name} object per the v17
  // Structure File). Missing IDs are allowed (1,2,5,8 is a valid set);
  // we keep gaps so the Alexa-side slot values still match what Loxone
  // accepts on the wire. Returns null if the structure hasn't loaded or
  // the control isn't a Radio.
  _resolveRadioOutputs(endpoint) {
    if (!this.structureCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Radio') return null;
    const outputs = control.details?.outputs;
    if (!outputs || typeof outputs !== 'object') return null;
    const out = [];
    for (const [k, v] of Object.entries(outputs)) {
      const id = Number.parseInt(k, 10);
      if (!Number.isFinite(id) || id < 1) continue;
      const name = (typeof v === 'string' && v.trim().length > 0)
        ? v.trim() : `Output ${id}`;
      out.push({ id, name });
    }
    out.sort((a, b) => a.id - b.id);
    // The optional "All Off" pseudo-output. When details.allOff is a
    // non-empty string, surface id=0 with that label — voice users get
    // "set heating to All Off" instead of a missing slot.
    const allOff = control.details?.allOff;
    if (typeof allOff === 'string' && allOff.trim().length > 0) {
      out.unshift({ id: 0, name: allOff.trim() });
    }
    return out;
  }

  // Currently-active output id from the activeOutput state. 0 = none
  // selected (matches the All Off slot when configured).
  _resolveRadioActive(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Radio') return null;
    const uuid = control.states?.activeOutput;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return Math.trunc(entry.value);
  }

  // Sequential sequences list. Loxone's details.sequences is a JSON array
  // of {id, name} pairs (unlike Radio's outputs which is a map). Same
  // gap-permissive parser as Radio's resolver: sort by id, surface a
  // synthesized "None" slot at id=0 so users can voice "set program to
  // none" to call triggerSequence/0. The None slot is unconditional for
  // Sequential because the structure file documents "0 = no sequence
  // active" as a defined state with no opt-in flag.
  _resolveSequences(endpoint) {
    if (!this.structureCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Sequential') return null;
    const seqs = control.details?.sequences;
    if (!Array.isArray(seqs)) return null;
    const out = [];
    for (const s of seqs) {
      if (!s || typeof s !== 'object') continue;
      const id = (typeof s.id === 'number') ? s.id : Number.parseInt(s.id, 10);
      if (!Number.isFinite(id) || id < 1) continue;
      const name = (typeof s.name === 'string' && s.name.trim().length > 0)
        ? s.name.trim() : `Sequence ${id}`;
      out.push({ id, name });
    }
    out.sort((a, b) => a.id - b.id);
    // Unconditional "None" slot. Loxone documents id=0 as the stop verb
    // — no per-install opt-in like Radio's details.allOff. The label is
    // hard-coded since Loxone doesn't expose a configurable name for it.
    out.unshift({ id: 0, name: 'None' });
    return out;
  }

  // Currently-active sequence id from the activeSequence state. 0 = no
  // sequence currently running.
  _resolveActiveSequence(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'Sequential') return null;
    const uuid = control.states?.activeSequence;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return Math.trunc(entry.value);
  }

  // ValueSelector live bounds from state (min/max/step are STATE UUIDs,
  // unlike Slider where they live in details). Falls back to the
  // hard-coded defaults when any of the three states is missing — keeps
  // Discovery functional on a cold cache. Caller (Discovery + dispatch)
  // re-reads at directive time, so a fresh control settles into its
  // real bounds after the first state push.
  _resolveValueSelectorBounds(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) {
      return { ...VALUE_SELECTOR_DEFAULT_BOUNDS };
    }
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ValueSelector') {
      return { ...VALUE_SELECTOR_DEFAULT_BOUNDS };
    }
    const read = (name) => {
      const uuid = control.states?.[name];
      if (!uuid) return null;
      const entry = this.stateCache.getValue(uuid);
      return (entry && Number.isFinite(entry.value)) ? entry.value : null;
    };
    const min  = read('min');
    const max  = read('max');
    const step = read('step');
    return {
      min:  min  != null ? min  : VALUE_SELECTOR_DEFAULT_BOUNDS.min,
      max:  max  != null ? max  : VALUE_SELECTOR_DEFAULT_BOUNDS.max,
      step: (step != null && step > 0) ? step : VALUE_SELECTOR_DEFAULT_BOUNDS.step,
    };
  }

  _resolveValueSelectorValue(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ValueSelector') return null;
    const uuid = control.states?.value;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? entry.value : null;
  }

  // ----- AudioZone state resolvers ----------------------------------------
  // All read from the same Loxone state names (volume, power, playState,
  // shuffle, repeat, source) shared between AudioZone v1 and v2.

  _resolveAudioVolume(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || !AUDIO_TYPES.has(control.type)) return null;
    const uuid = control.states?.volume;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? clamp(Math.round(entry.value), 0, 100) : null;
  }

  _resolveAudioPower(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || !AUDIO_TYPES.has(control.type)) return null;
    const uuid = control.states?.power;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return Number(entry.value) === 0 ? 'OFF' : 'ON';
  }

  _resolveAudioPlaybackState(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || !AUDIO_TYPES.has(control.type)) return null;
    const uuid = control.states?.playState;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return alexaPlaybackStateFromLoxone(entry.value);
  }

  _resolveAudioShuffle(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || !AUDIO_TYPES.has(control.type)) return null;
    const uuid = control.states?.shuffle;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return Number(entry.value) !== 0;   // true=on, false=off
  }

  _resolveAudioRepeat(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || !AUDIO_TYPES.has(control.type)) return null;
    const uuid = control.states?.repeat;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return ALEXA_BY_REPEAT[entry.value] || null;
  }

  _resolveAudioSourceSlot(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || !AUDIO_TYPES.has(control.type)) return null;
    const uuid = control.states?.source;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return String(entry.value);   // Alexa modes are strings even when numeric
  }

  // Read + parse the Loxone sourceList JSON state. Used by Discovery to
  // build dynamic Source-mode definitions; falls back to generic numbered
  // slots when the state cache hasn't received it yet.
  _resolveSourceList(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return [];
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || !AUDIO_TYPES.has(control.type)) return [];
    const uuid = control.states?.sourceList;
    if (uuid) {
      const entry = this.stateCache.getText(uuid);
      const parsed = parseSourceList(entry?.text);
      if (parsed.length > 0) {
        // Debug: the exact favorite list we will project into Alexa
        // ModeController.supportedModes at Discovery time. `value` is
        // String(slot); each `slot` is sent verbatim as the second path
        // segment of playZoneFav/<slot> (V2) or source/<slot> (V1). If the
        // zone plays the wrong favorite, compare these (slot,name) pairs
        // against the raw envelope below and the command logged at
        // invocation time.
        this.log.debug({
          endpointId: endpoint.endpointId,
          uuid: endpoint.uuid,
          controlType: control.type,
          sourceListStateUuid: uuid,
          source: 'sourceList-state',
          rawSourceList: entry?.text,
          modes: parsed.map((s) => ({ value: String(s.slot), slot: s.slot, name: s.name })),
        }, `Discovery: advertising ${parsed.length} audio source mode(s) to Alexa`);
        return parsed;
      }
    }
    // Fallback: 8 generic slots so Discovery emits a usable ModeController
    // even before any state has arrived. User re-discovers after favorites
    // are configured in Loxone to pick up the real names.
    const out = [];
    for (let i = 1; i <= 8; i++) out.push({ slot: i, name: `Source ${i}` });
    this.log.debug({
      endpointId: endpoint.endpointId,
      uuid: endpoint.uuid,
      controlType: control.type,
      sourceListStateUuid: uuid || null,
      source: 'fallback-generic',
      modes: out.map((s) => ({ value: String(s.slot), slot: s.slot, name: s.name })),
    }, 'Discovery: sourceList state not yet cached — advertising 8 generic fallback slots');
    return out;
  }

  // Map the polarity-applied binary-sensor reading to the ModeController
  // slot string. Returns "1" for the active state, "0" for inactive,
  // or null if the underlying state can't be resolved (cold cache,
  // wrong control type, etc.). Used by the binary-sensor ModeController
  // role across all three sensor control types.
  _resolveBinarySensorMode(endpoint) {
    if (!this.structureCache) return null;
    const control = this.structureCache.getControl(endpoint?.uuid);
    if (!control) return null;
    let state = null;
    if (control.type === 'PresenceDetector') {
      state = this._resolvePresenceDetectorState(endpoint);
    } else if (control.type === 'WindowMonitor') {
      state = this._resolveWindowMonitorState(endpoint);
    } else if (control.type === 'InfoOnlyDigital') {
      state = this._resolveInfoOnlyDigitalState(endpoint);
    } else {
      return null;
    }
    if (state == null) return null;
    return state === 'DETECTED' ? '1' : '0';
  }

  // ----- Read-only sensor resolvers ----------------------------------------

  // PresenceDetector.active → MotionSensor.detectionState. Loxone state
  // is a numeric 0/1; non-zero means presence detected. The per-endpoint
  // `sensorPolarityInverted` flag flips the result (set by default — see
  // `polarize` for the rationale).
  _resolvePresenceDetectorState(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'PresenceDetector') return null;
    const uuid = control.states?.active;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    const raw = entry.value !== 0 ? 'DETECTED' : 'NOT_DETECTED';
    return polarize(raw, endpoint.sensorPolarityInverted);
  }

  // WindowMonitor.windowStates → ContactSensor.detectionState. Loxone
  // ships a comma-separated text state where each entry is a per-window
  // bitmask: 1=closed, 2=tilted, 4=open. Aggregate semantic:
  // DETECTED (contact present) iff EVERY monitored window reports closed;
  // any tilted/open/unknown → NOT_DETECTED.
  _resolveWindowMonitorState(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'WindowMonitor') return null;
    const uuid = control.states?.windowStates;
    if (!uuid) return null;
    const entry = this.stateCache.getText(uuid);
    if (!entry || typeof entry.text !== 'string' || !entry.text.length) return null;
    const states = entry.text.split(',').map((s) => Number.parseInt(s.trim(), 10));
    // 0 (unknown/offline) or non-1 bits set → not fully closed.
    const allClosed = states.length > 0
      && states.every((n) => Number.isFinite(n) && n === 1);
    const raw = allClosed ? 'DETECTED' : 'NOT_DETECTED';
    return polarize(raw, endpoint.sensorPolarityInverted);
  }

  // InfoOnlyDigital.active → boolean. Returns 'DETECTED' / 'NOT_DETECTED'
  // for either MotionSensor or ContactSensor — the caller picks which
  // namespace to wrap it in based on the device's advertised capabilities.
  // `sensorPolarityInverted` flips the result post-mapping.
  _resolveInfoOnlyDigitalState(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'InfoOnlyDigital') return null;
    const uuid = control.states?.active;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    const raw = entry.value !== 0 ? 'DETECTED' : 'NOT_DETECTED';
    return polarize(raw, endpoint.sensorPolarityInverted);
  }

  // InfoOnlyAnalog.value → numeric reading (raw, no scaling). Format/unit
  // is encoded in control.details.format; callers that need a scale read it
  // via thermostatScaleFor (same °C/°F regex applies).
  _resolveInfoOnlyAnalogValue(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'InfoOnlyAnalog') return null;
    const uuid = control.states?.value;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    return (entry && Number.isFinite(entry.value)) ? entry.value : null;
  }

  // Resolve the current thermostat mode by reading Loxone's operatingMode
  // state. Returns one of AUTO/HEAT/COOL/OFF, or null if the state isn't
  // cached yet or maps to nothing we support.
  _resolveThermostatMode(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'IRoomControllerV2') return null;
    const uuid = control.states?.operatingMode;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    return alexaModeFromLoxone(entry.value);
  }

  // ----- AudioZone handlers --------------------------------------------

  // SetVolume / AdjustVolume → `volume/{n}`. Loxone's volume scale is
  // 0..100, same as Alexa's. AdjustVolume reads current from state cache
  // and computes new = clamp(current + delta, 0, 100).
  //
  // Step semantics: Alexa's AdjustVolume directive carries both a `volume`
  // delta and a `volumeDefault` boolean. When the user says "louder"
  // without specifying an amount, `volumeDefault: true` and Alexa picks
  // its own delta (often just 1, which feels glacial on a 0..100 scale).
  // When the user says "louder by 5", `volumeDefault: false` and we
  // respect the explicit value. We substitute our per-device
  // `audioVolumeStep` setting (default 5) when Alexa's value is the
  // default — gives "louder" a meaningful kick without breaking explicit
  // "louder by N" voice commands.
  async _handleSetVolume(directive, relative) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    if (!endpoint.uuid) return errorResponse(h, 'INVALID_DIRECTIVE',
      `Endpoint ${endpointId} has no uuid mapping`);

    let target;
    if (relative) {
      let delta = Number(directive.payload?.volume);
      if (!Number.isFinite(delta)) {
        return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid volume delta');
      }
      // Substitute our configured step for Alexa's default delta, preserving
      // the sign (so "quieter" still goes down). Explicit user-specified
      // values flow through unchanged.
      if (directive.payload?.volumeDefault === true) {
        const stepMag = Number.isFinite(endpoint.audioVolumeStep) && endpoint.audioVolumeStep > 0
          ? endpoint.audioVolumeStep
          : 5;
        const sign = delta < 0 ? -1 : 1;
        delta = sign * stepMag;
      }
      const current = this._resolveAudioVolume(endpoint);
      if (current == null) {
        return errorResponse(h, 'INVALID_VALUE',
          'Cannot adjust volume — no current value cached');
      }
      target = clamp(Math.round(current + delta), 0, 100);
    } else {
      const requested = Number(directive.payload?.volume);
      if (!Number.isFinite(requested)) {
        return errorResponse(h, 'INVALID_DIRECTIVE', 'invalid volume');
      }
      target = clamp(Math.round(requested), 0, 100);
    }

    const command = `volume/${target}`;
    const res = await this._sendUuidCommand(endpoint, command, h);
    if (!res.ok) return res.errorResponse;

    return this._audioResponse(h, endpointId, {
      namespace: 'Alexa.Speaker', name: 'volume', value: target,
    });
  }

  // SetMute → off (mute=true) or on (mute=false). Loxone's `off` silences
  // this specific speaker; other speakers in the same group keep playing.
  // This matches user expectation: "mute the kitchen" = silence only the
  // kitchen, not the whole house.
  async _handleSetMute(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    if (!endpoint.uuid) return errorResponse(h, 'INVALID_DIRECTIVE',
      `Endpoint ${endpointId} has no uuid mapping`);

    const muteRequested = directive.payload?.mute === true;
    const command = muteRequested ? 'off' : 'on';
    const res = await this._sendUuidCommand(endpoint, command, h);
    if (!res.ok) return res.errorResponse;

    // We don't echo a `muted` property here (Discovery declared only
    // `volume` in supported), but PowerController reads the same underlying
    // state — Alexa keeps both UIs aligned via ChangeReports.
    return {
      context: { properties: [] },
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: h.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
    };
  }

  // PlaybackController dispatch. Five directives all map to single-token
  // Loxone commands. Stop has no Loxone equivalent; `pause` is the closest
  // (advertised in supportedOperations for the voice-routing benefit).
  async _handlePlayback(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    if (!endpoint.uuid) return errorResponse(h, 'INVALID_DIRECTIVE',
      `Endpoint ${endpointId} has no uuid mapping`);

    let command;
    switch (h.name) {
      case 'Play':     command = 'play';  break;
      case 'Pause':    command = 'pause'; break;
      case 'Stop':     command = 'pause'; break;   // closest Loxone analog
      case 'Next':     command = 'next';  break;
      case 'Previous': command = 'prev';  break;
      default:
        return errorResponse(h, 'INVALID_DIRECTIVE',
          `Unsupported playback op: ${h.name}`);
    }
    const res = await this._sendUuidCommand(endpoint, command, h);
    if (!res.ok) return res.errorResponse;

    return {
      context: { properties: [] },
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: h.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
    };
  }

  // ToggleController dispatch — currently only the audio shuffle instance.
  // Loxone's `shuffle` command toggles (no explicit on/off), so the handler
  // reads the current state and skips the write when the requested state
  // already matches reality. The state-reporter will still send a
  // ChangeReport from Alexa's app even on the no-op path, since we echo
  // the property in the directive response.
  async _handleToggle(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    if (!endpoint.uuid) return errorResponse(h, 'INVALID_DIRECTIVE',
      `Endpoint ${endpointId} has no uuid mapping`);

    if (h.instance !== TOGGLE_INSTANCE_SHUFFLE) {
      return errorResponse(h, 'INVALID_DIRECTIVE',
        `Unsupported ToggleController instance: ${h.instance}`);
    }
    const wantOn = h.name === 'TurnOn';
    const currentOn = this._resolveAudioShuffle(endpoint);
    // currentOn null → cache cold; send anyway and trust the toggle to land
    // in the right state on average. The next state event corrects any drift.
    const needsToggle = currentOn == null ? true : (currentOn !== wantOn);

    if (needsToggle) {
      const res = await this._sendUuidCommand(endpoint, 'shuffle', h);
      if (!res.ok) return res.errorResponse;
    } else {
      this.log.debug({ endpointId, wantOn, currentOn },
        'shuffle: already in requested state — no command sent');
    }

    return this._audioResponse(h, endpointId, {
      namespace: 'Alexa.ToggleController',
      instance:  TOGGLE_INSTANCE_SHUFFLE,
      name:      'toggleState',
      value:     wantOn ? 'ON' : 'OFF',
    });
  }

  // Shared "send + log + map failure" wrapper for audio handlers. Returns
  // { ok: true, res } or { ok: false, errorResponse } — caller branches.
  async _sendUuidCommand(endpoint, command, directiveHeader) {
    this.log.debug(
      { endpointId: directiveHeader?.correlationToken ? endpoint.endpointId : null,
        loxoneUuid: endpoint.uuid, command },
      `${directiveHeader.namespace}.${directiveHeader.name} → Loxone command`,
    );
    const res = await this.loxoneCommand.sendByUuid({
      msNo: endpoint.msNo || 1,
      uuid: endpoint.uuid,
      command,
    });
    if (!res.ok) {
      this.log.warn({ endpointId: endpoint.endpointId, command, res },
        'Loxone audio command failed');
      return {
        ok: false,
        errorResponse: errorResponse(directiveHeader, 'ENDPOINT_UNREACHABLE',
          `Loxone command failed: ${res.category} ${res.stderr || ''}`.trim()),
      };
    }
    this.log.debug(
      { endpointId: endpoint.endpointId, command, category: res.category, stdout: res.stdout, durationMs: res.durationMs },
      `${directiveHeader.namespace}.${directiveHeader.name} → Loxone OK`,
    );
    return { ok: true, res };
  }

  // Build a standard Alexa.Response for an audio directive with one
  // property echo. Same envelope shape across all audio handlers — the
  // namespace/instance/name/value bundle is the only thing that varies.
  _audioResponse(directiveHeader, endpointId, prop) {
    const property = {
      namespace:    prop.namespace,
      name:         prop.name,
      value:        prop.value,
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    };
    if (prop.instance) property.instance = prop.instance;
    return {
      context: { properties: [property] },
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: directiveHeader.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
    };
  }

  // Build the standard "directive done" response with the relevant
  // context.properties for ColorPickerV2 — same shape for all four
  // capability handlers, so factored here.
  _colorPickerResponse(directiveHeader, endpointId, { brightness, powerState, color, colorTemperatureInKelvin }) {
    const properties = [{
      namespace: 'Alexa.PowerController',
      name: 'powerState',
      value: powerState,
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    }, {
      namespace: 'Alexa.BrightnessController',
      name: 'brightness',
      value: brightness,
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    }];
    if (color) {
      properties.push({
        namespace: 'Alexa.ColorController',
        name: 'color',
        value: color,
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 500,
      });
    }
    if (colorTemperatureInKelvin) {
      properties.push({
        namespace: 'Alexa.ColorTemperatureController',
        name: 'colorTemperatureInKelvin',
        value: colorTemperatureInKelvin,
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 500,
      });
    }
    return {
      event: {
        header: header('Alexa', 'Response', PROTO_VERSION, {
          correlationToken: directiveHeader.correlationToken,
        }),
        endpoint: { endpointId },
        payload: {},
      },
      context: { properties },
    };
  }

  // Resolve the current state of a ColorPickerV2 endpoint by parsing the
  // `states.color` text value out of the cache. Returns null when the
  // structure / state isn't available, or when the text doesn't match
  // either of Loxone's two known shapes (`hsv(...)` / `temp(...)`).
  _resolveColorPickerState(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'ColorPickerV2') return null;
    const colorUuid = control.states?.color;
    if (!colorUuid) return null;
    const entry = this.stateCache.getText(colorUuid);
    if (!entry || !entry.text) return null;
    return parseColorState(entry.text);
  }

  // ----- LightControllerV2 mood helpers ----------------------------------

  // Resolve the Loxone mood list for a LightControllerV2 endpoint via the
  // structure cache (state UUID) + state cache (text value). Returns
  // [{id, name}, ...] or null if the data isn't available yet — Discovery
  // gracefully falls back to PowerController-only in that case.
  _resolveMoods(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'LightControllerV2') return null;
    const moodListUuid = control.states?.moodList;
    if (!moodListUuid) return null;
    const entry = this.stateCache.getText(moodListUuid);
    if (!entry || !entry.text) return null;
    let parsed;
    try {
      parsed = JSON.parse(entry.text);
    } catch (err) {
      this.log.warn({ endpointId: endpoint.endpointId, err: err.message },
        'moodList JSON parse failed');
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const out = [];
    for (const m of parsed) {
      if (!m || typeof m !== 'object') continue;
      // Loxone uses numeric `id`; tolerate string IDs defensively.
      const id = (typeof m.id === 'number') ? m.id : Number.parseInt(m.id, 10);
      if (!Number.isFinite(id)) continue;
      const name = (typeof m.name === 'string' && m.name.trim().length > 0)
        ? m.name.trim()
        : `Mood ${id}`;
      out.push({ id, name });
    }
    return out;
  }

  // LightController v1 scene list. Same shape contract as _resolveMoods —
  // returns [{id, name}] or null. Parses sceneList text via parseSceneList
  // (CSV-with-quoted-names format, different from v2's JSON moodList).
  _resolveScenes(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'LightController') return null;
    const sceneListUuid = control.states?.sceneList;
    if (!sceneListUuid) return null;
    const entry = this.stateCache.getText(sceneListUuid);
    if (!entry || !entry.text) return null;
    const parsed = parseSceneList(entry.text);
    return parsed.length > 0 ? parsed : null;
  }

  // LightController v1 live state: reads activeScene (numeric) and
  // derives PowerController.powerState (OFF iff scene 0 — Loxone's
  // hardcoded "all off" scene). Returns same shape as
  // _resolveLightControllerState so the ReportState consumer can stay
  // unchanged structurally. Mode is stringified to match Alexa's wire
  // shape for ModeController.mode (always a string).
  _resolveLightSceneState(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'LightController') return null;
    const uuid = control.states?.activeScene;
    if (!uuid) return null;
    const entry = this.stateCache.getValue(uuid);
    if (!entry || !Number.isFinite(entry.value)) return null;
    const id = Math.trunc(entry.value);
    return {
      powerState: id === OFF_SCENE_ID ? 'OFF' : 'ON',
      mode:       String(id),
    };
  }

  // Resolve current { powerState, mode } for a LightControllerV2 endpoint
  // by reading its activeMoods text state. Used by ReportState. Returns
  // null if the state isn't yet cached (caller falls back to stubbed OFF).
  _resolveLightControllerState(endpoint) {
    if (!this.structureCache || !this.stateCache || !endpoint?.uuid) return null;
    const control = this.structureCache.getControl(endpoint.uuid);
    if (!control || control.type !== 'LightControllerV2') return null;
    const activeUuid = control.states?.activeMoods;
    if (!activeUuid) return null;
    const entry = this.stateCache.getText(activeUuid);
    if (!entry || !entry.text) return null;
    const ids = parseActiveMoods(entry.text);
    if (ids.length === 0) return { powerState: 'OFF', mode: null };
    // PowerController: OFF iff the only active mood is All-Off.
    const isOff = ids.length === 1 && ids[0] === OFF_MOOD_ID;
    return {
      powerState: isOff ? 'OFF' : 'ON',
      mode:       String(ids[0]),  // first active = Alexa-visible mode
    };
  }

  // Build a StateReport for one endpoint. Reports every supported property
  // PLUS connectivity. The values are currently stubbed (PowerController →
  // 'OFF') because we have no endpointId → Loxone UUID mapping yet; that
  // arrives with LoxApp3.json device discovery in a later step. Returning a
  // *valid* StateReport (even with stubbed power state) keeps Alexa from
  // marking the device unresponsive after Discovery.
  _handleReportState(directive) {
    const h = directive.header;
    const endpointId = directive.endpoint?.endpointId;
    if (!endpointId) {
      return errorResponse(h, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId');
    }
    const endpoint = this.byId.get(endpointId);
    if (!endpoint) {
      return errorResponse(h, 'NO_SUCH_ENDPOINT', `Unknown endpointId ${endpointId}`);
    }

    const properties = [];
    // LightControllerV2: live state via activeMoods.
    const lightState = this._resolveLightControllerState(endpoint);
    // LightController (v1): live state via activeScene.
    const sceneState = this._resolveLightSceneState(endpoint);
    // Whichever resolver matched — feed it into the same PowerController +
    // ModeController emission below. Both produce identical {powerState,
    // mode} shapes; the only difference is which ModeController instance
    // the mode goes under.
    const lightLike = lightState || sceneState;
    const lightModeInstance = sceneState ? MODE_INSTANCE_LIGHT_SCENE : MODE_INSTANCE;
    // ColorPickerV2: live state via the color text state.
    const colorState = this._resolveColorPickerState(endpoint);
    // Plain Dimmer: live state via the `position` value state.
    const dimmerState = this._resolveDimmerState(endpoint);

    if (endpoint.capabilities?.includes('PowerController')) {
      let powerValue = 'OFF';
      let uncertainty = 60_000;
      if (lightLike) {
        powerValue  = lightLike.powerState;
        uncertainty = 0;
      } else if (colorState) {
        powerValue  = colorState.brightness > 0 ? 'ON' : 'OFF';
        uncertainty = 0;
      } else if (dimmerState) {
        powerValue  = dimmerState.powerState;
        uncertainty = 0;
      } else {
        const ctrl = this.structureCache?.getControl(endpoint.uuid);
        if (ctrl?.type === 'ACControl') {
          // ACControl path — `status` state is authoritative.
          const acPower = this._resolveACPower(endpoint);
          if (acPower != null) {
            powerValue  = acPower;
            uncertainty = 0;
          }
        } else if (ctrl?.type === 'Ventilation') {
          // Ventilation has no explicit on/off — derive from
          // (activeTimerProfile, speed). OFF iff manual timer running at
          // speed 0 (user deliberately turned it off). Anything else is
          // ON: speed>0 means running, speed=0 without manual timer means
          // "in auto, quiet right now" which is still "on" semantically.
          const tp = this._resolveVentTimerProfile(endpoint);
          const sp = this._resolveVentSpeed(endpoint);
          if (tp != null || sp != null) {
            const offByManualZero =
              tp === VENT_TIMER_PROFILE_MANUAL && (sp ?? 0) === 0;
            powerValue  = offByManualZero ? 'OFF' : 'ON';
            uncertainty = 0;
          }
        } else if (ctrl?.type === 'Switch' || ctrl?.type === 'TimedSwitch') {
          // Switch/TimedSwitch — `active` state is authoritative. Reading
          // it here is what makes the post-Discovery StateReport correct
          // (previously stubbed to OFF until the first manual toggle).
          const swPower = this._resolveSwitchPower(endpoint);
          if (swPower != null) {
            powerValue  = swPower;
            uncertainty = 0;
          }
        }
      }
      // Any control type whose state still hasn't arrived from the
      // Miniserver falls through with the honest unknown→OFF stub below.
      // Better a valid StateReport than none at all (Alexa marks the
      // device unresponsive in that case); uncertainty stays high so
      // Alexa treats it as a guess until the next ChangeReport.
      properties.push({
        namespace: 'Alexa.PowerController',
        name: 'powerState',
        value: powerValue,
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: uncertainty,
      });
    }
    if (lightLike && endpoint.capabilities?.includes('ModeController') && lightLike.mode != null) {
      properties.push({
        namespace: 'Alexa.ModeController',
        instance: lightModeInstance,
        name: 'mode',
        value: lightLike.mode,
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 0,
      });
    }
    // ACControl fan-speed mode (independent of the light-mode block above —
    // an AC isn't a light, so lightLike is null and we read fan separately).
    if (endpoint.capabilities?.includes('ModeController')) {
      const acCtrl = this.structureCache?.getControl(endpoint.uuid);
      if (acCtrl?.type === 'ACControl') {
        const fan = this._resolveACFan(endpoint);
        if (fan != null) {
          properties.push({
            namespace: 'Alexa.ModeController',
            instance: MODE_INSTANCE_AC_FAN,
            name: 'mode',
            value: fan,
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          });
        }
      }
    }
    // Ventilation mode (per-install mode list from details.modes).
    if (endpoint.capabilities?.includes('ModeController')) {
      const ventCtrl = this.structureCache?.getControl(endpoint.uuid);
      if (ventCtrl?.type === 'Ventilation') {
        const mode = this._resolveVentMode(endpoint);
        if (mode != null) {
          properties.push({
            namespace: 'Alexa.ModeController',
            instance: MODE_INSTANCE_VENT_MODE,
            name: 'mode',
            value: String(mode),
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          });
        }
      }
    }
    // Radio (Loxone "Radio buttons") active output. 0 maps to the All-Off
    // pseudo-slot Discovery advertises when details.allOff is configured.
    if (endpoint.capabilities?.includes('ModeController')) {
      const radioCtrl = this.structureCache?.getControl(endpoint.uuid);
      if (radioCtrl?.type === 'Radio') {
        const active = this._resolveRadioActive(endpoint);
        if (active != null) {
          properties.push({
            namespace: 'Alexa.ModeController',
            instance: MODE_INSTANCE_RADIO,
            name: 'mode',
            value: String(active),
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          });
        }
      }
    }
    // Sequential active sequence. 0 = "no sequence running" (the
    // synthesized None slot in Discovery).
    if (endpoint.capabilities?.includes('ModeController')) {
      const seqCtrl = this.structureCache?.getControl(endpoint.uuid);
      if (seqCtrl?.type === 'Sequential') {
        const active = this._resolveActiveSequence(endpoint);
        if (active != null) {
          properties.push({
            namespace: 'Alexa.ModeController',
            instance: MODE_INSTANCE_SEQUENCE,
            name: 'mode',
            value: String(active),
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          });
        }
      }
    }
    // Binary-sensor ModeController state ("1"/"0" after polarity). The
    // value matches what Discovery advertised as the active/inactive
    // slot. Same resolver covers PresenceDetector / WindowMonitor /
    // InfoOnlyDigital — picks the right per-type resolver internally.
    if (endpoint.capabilities?.includes('ModeController')) {
      const bsCtrl = this.structureCache?.getControl(endpoint.uuid);
      const isBinary = bsCtrl && (
        bsCtrl.type === 'PresenceDetector' ||
        bsCtrl.type === 'WindowMonitor' ||
        bsCtrl.type === 'InfoOnlyDigital'
      );
      if (isBinary) {
        const mode = this._resolveBinarySensorMode(endpoint);
        if (mode != null) {
          properties.push({
            namespace: 'Alexa.ModeController',
            instance: MODE_INSTANCE_BINARY_SENSOR,
            name: 'mode',
            value: mode,
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          });
        }
      }
    }
    if (colorState && endpoint.capabilities?.includes('BrightnessController')) {
      properties.push({
        namespace: 'Alexa.BrightnessController',
        name: 'brightness',
        value: colorState.brightness,
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 0,
      });
    }
    // Plain Dimmer brightness (mutually exclusive with colorState — a Dimmer
    // is never a ColorPickerV2, so only one of these blocks ever fires).
    if (dimmerState && dimmerState.brightness != null
        && endpoint.capabilities?.includes('BrightnessController')) {
      properties.push({
        namespace: 'Alexa.BrightnessController',
        name: 'brightness',
        value: dimmerState.brightness,
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 0,
      });
    }
    if (colorState?.mode === 'hsv' && endpoint.capabilities?.includes('ColorController')) {
      properties.push({
        namespace: 'Alexa.ColorController',
        name: 'color',
        value: {
          hue:        colorState.hue,
          saturation: colorState.saturation / 100,
          brightness: colorState.brightness / 100,
        },
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 0,
      });
    }
    if (colorState?.mode === 'temp' && endpoint.capabilities?.includes('ColorTemperatureController')) {
      properties.push({
        namespace: 'Alexa.ColorTemperatureController',
        name: 'colorTemperatureInKelvin',
        value: colorState.kelvin,
        timeOfSample: nowIso(),
        uncertaintyInMilliseconds: 0,
      });
    }
    if (endpoint.capabilities?.includes('RangeController')) {
      const rangeValue = this._resolveRangeValue(endpoint);
      // No cached value yet → omit the property rather than fabricate
      // one. Alexa preserves the last-known value; better stale-but-real
      // than wrong-from-cold-cache.
      if (rangeValue != null) {
        const controlType = this.structureCache?.getControl(endpoint.uuid)?.type;
        properties.push({
          namespace: 'Alexa.RangeController',
          instance: this._rangeInstanceFor(controlType),
          name: 'rangeValue',
          value: rangeValue,
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
    }
    if (endpoint.capabilities?.includes('ThermostatController')) {
      const control = this.structureCache?.getControl(endpoint.uuid);
      const scale = thermostatScaleFor(control);
      // Per-control-type resolvers — IRC and AC store the setpoint and
      // mode under different state names; the dispatch stays untyped
      // by control type at the caller.
      const isAC = control?.type === 'ACControl';
      const target = isAC
        ? this._resolveACTargetTemperature(endpoint)
        : this._resolveTargetSetpoint(endpoint);
      const mode = isAC
        ? this._resolveACMode(endpoint)
        : this._resolveThermostatMode(endpoint);
      if (target != null) {
        properties.push({
          namespace: 'Alexa.ThermostatController',
          name: 'targetSetpoint',
          value: { value: target, scale },
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
      if (mode != null) {
        properties.push({
          namespace: 'Alexa.ThermostatController',
          name: 'thermostatMode',
          value: mode,
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
    }
    if (endpoint.capabilities?.includes('TemperatureSensor')) {
      const control = this.structureCache?.getControl(endpoint.uuid);
      const scale = thermostatScaleFor(control);
      // Four sources of truth depending on control type:
      //   IRoomControllerV2 → tempActual state
      //   ACControl         → temperature state
      //   Ventilation       → temperatureIndoor state
      //   InfoOnlyAnalog    → value state (when user picked TemperatureSensor role)
      let temp = null;
      if (control?.type === 'InfoOnlyAnalog') {
        temp = this._resolveInfoOnlyAnalogValue(endpoint);
      } else if (control?.type === 'ACControl') {
        temp = this._resolveACTemperature(endpoint);
      } else if (control?.type === 'Ventilation') {
        temp = this._resolveVentTemperature(endpoint);
      } else {
        temp = this._resolveTempActual(endpoint);
      }
      if (temp != null) {
        properties.push({
          namespace: 'Alexa.TemperatureSensor',
          name: 'temperature',
          value: { value: temp, scale },
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
    }
    if (endpoint.capabilities?.includes('HumiditySensor')) {
      // Two sources of truth:
      //   InfoOnlyAnalog → value state (user picked the Humidity role)
      //   Ventilation    → humidityIndoor state
      // Alexa.HumiditySensor.relativeHumidity is a plain percentage
      // (0..100) — NOT wrapped in {value: N} like TemperatureSensor.temperature.
      // Round defensively; Loxone can ship floating-point readings.
      const control = this.structureCache?.getControl(endpoint.uuid);
      let v = null;
      if (control?.type === 'Ventilation') {
        v = this._resolveVentHumidity(endpoint);
      } else {
        v = this._resolveInfoOnlyAnalogValue(endpoint);
      }
      if (v != null) {
        properties.push({
          namespace: 'Alexa.HumiditySensor',
          name: 'relativeHumidity',
          value: Math.round(v),
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
    }
    if (endpoint.capabilities?.includes('MotionSensor')) {
      // PresenceDetector.active OR InfoOnlyDigital.active (Motion role).
      const control = this.structureCache?.getControl(endpoint.uuid);
      const state = control?.type === 'InfoOnlyDigital'
        ? this._resolveInfoOnlyDigitalState(endpoint)
        : this._resolvePresenceDetectorState(endpoint);
      if (state != null) {
        properties.push({
          namespace: 'Alexa.MotionSensor',
          name: 'detectionState',
          value: state,
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
    }
    if (endpoint.capabilities?.includes('ContactSensor')) {
      // WindowMonitor.windowStates (aggregated) OR InfoOnlyDigital.active.
      const control = this.structureCache?.getControl(endpoint.uuid);
      const state = control?.type === 'InfoOnlyDigital'
        ? this._resolveInfoOnlyDigitalState(endpoint)
        : this._resolveWindowMonitorState(endpoint);
      if (state != null) {
        properties.push({
          namespace: 'Alexa.ContactSensor',
          name: 'detectionState',
          value: state,
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
    }
    // AudioZone properties. Each resolver returns null when its state hasn't
    // arrived yet; we omit the corresponding property rather than fabricate.
    if (endpoint.capabilities?.includes('Speaker')) {
      const vol = this._resolveAudioVolume(endpoint);
      if (vol != null) {
        properties.push({
          namespace: 'Alexa.Speaker',
          name: 'volume',
          value: vol,
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
      // `muted` is derived from the Loxone power state (off ⇒ muted) since
      // we map SetMute to the same on/off command path. Reported here so
      // Alexa's view of the device matches what our handler claims to do.
      const power = this._resolveAudioPower(endpoint);
      if (power != null) {
        properties.push({
          namespace: 'Alexa.Speaker',
          name: 'muted',
          value: power === 'OFF',
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
    }
    if (endpoint.capabilities?.includes('PlaybackStateReporter')) {
      const state = this._resolveAudioPlaybackState(endpoint);
      if (state != null) {
        properties.push({
          namespace: 'Alexa.PlaybackStateReporter',
          name: 'playbackState',
          value: { state },
          timeOfSample: nowIso(),
          uncertaintyInMilliseconds: 0,
        });
      }
    }
    if (endpoint.capabilities?.includes('ToggleController')) {
      const ctrl = this.structureCache?.getControl(endpoint.uuid);
      if (ctrl && AUDIO_TYPES.has(ctrl.type)) {
        const on = this._resolveAudioShuffle(endpoint);
        if (on != null) {
          properties.push({
            namespace: 'Alexa.ToggleController',
            instance:  TOGGLE_INSTANCE_SHUFFLE,
            name:      'toggleState',
            value:     on ? 'ON' : 'OFF',
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          });
        }
      }
    }
    if (endpoint.capabilities?.includes('ModeController')) {
      const ctrl = this.structureCache?.getControl(endpoint.uuid);
      if (ctrl && AUDIO_TYPES.has(ctrl.type)) {
        const repeat = this._resolveAudioRepeat(endpoint);
        if (repeat != null) {
          properties.push({
            namespace: 'Alexa.ModeController',
            instance:  MODE_INSTANCE_REPEAT,
            name:      'mode',
            value:     repeat,
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          });
        }
        const source = this._resolveAudioSourceSlot(endpoint);
        if (source != null) {
          properties.push({
            namespace: 'Alexa.ModeController',
            instance:  MODE_INSTANCE_SOURCE,
            name:      'mode',
            value:     source,
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          });
        }
      }
    }
    // Override the PowerController stub above for audio endpoints — we
    // actually know the power state from the `power` state UUID.
    if (endpoint.capabilities?.includes('PowerController')) {
      const ctrl = this.structureCache?.getControl(endpoint.uuid);
      if (ctrl && AUDIO_TYPES.has(ctrl.type)) {
        const audioPower = this._resolveAudioPower(endpoint);
        if (audioPower != null) {
          // Find and replace the existing PowerController property (added
          // by the generic block earlier) with the audio-real value.
          const idx = properties.findIndex(
            (p) => p.namespace === 'Alexa.PowerController' && p.name === 'powerState'
          );
          const real = {
            namespace: 'Alexa.PowerController',
            name: 'powerState',
            value: audioPower,
            timeOfSample: nowIso(),
            uncertaintyInMilliseconds: 0,
          };
          if (idx >= 0) properties[idx] = real;
          else          properties.push(real);
        }
      }
    }
    // Always report connectivity. By the time we got here the daemon is
    // demonstrably reachable and the Miniserver session has its own state;
    // a more nuanced "OK vs UNREACHABLE" can come later from state.json.
    properties.push({
      namespace: 'Alexa.EndpointHealth',
      name: 'connectivity',
      value: { value: 'OK' },
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 0,
    });

    this.log.info(
      {
        endpointId,
        propertyCount: properties.length,
        hasLightState: !!lightState,
        hasColorState: !!colorState,
        colorMode: colorState?.mode,
      },
      'StateReport assembled',
    );
    return stateReportResponse(h, endpointId, directive.endpoint?.scope, properties);
  }
}

// Parse Loxone's ColorPickerV2 `color` text state. Loxone uses two
// alternating shapes:
//   - HSV mode:  "hsv(120,80,50)"   -- hue 0-360, sat 0-100, val 0-100
//   - Temp mode: "temp(50,4000)"     -- brightness 0-100, kelvin
// Returns { mode, brightness, ... } or null when the string doesn't match.
// The text-state is what state-reporter.js subscribes to for ChangeReport
// emission, and what the directive handlers read to preserve dimensions.
const RE_HSV  = /^hsv\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/i;
const RE_TEMP = /^temp\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/i;
function parseColorState(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  let m = trimmed.match(RE_HSV);
  if (m) {
    const hue = Math.round(Number(m[1]));
    const sat = Math.round(Number(m[2]));
    const val = Math.round(Number(m[3]));
    if (![hue, sat, val].every(Number.isFinite)) return null;
    return {
      mode:       'hsv',
      brightness: val,
      hue,
      saturation: sat,
    };
  }
  m = trimmed.match(RE_TEMP);
  if (m) {
    const bri = Math.round(Number(m[1]));
    const k   = Math.round(Number(m[2]));
    if (![bri, k].every(Number.isFinite)) return null;
    return {
      mode:       'temp',
      brightness: bri,
      kelvin:     k,
    };
  }
  return null;
}

// Clamp `v` to [lo, hi]. Used for brightness (0-100), kelvin (2700-6500),
// hue (0-360). Standalone so it stays import-free for state-reporter.
function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// Parse LightController (v1) `sceneList` state into a [{id, name}] list.
// The Loxone wire format (v17 Structure File p.94) is a CSV-style string:
//   1="Szene 1",2="Szene 2",7="Mein Mix"
// where the quoted name MAY contain escaped quotes ("\""). Unlike v2's
// moodList (JSON), this has no formal grammar — Loxone just splits on
// commas at the top level. We parse defensively: any malformed entry is
// skipped; a wholly malformed string returns []. Caller (Discovery)
// treats [] as "no scenes known yet" and degrades to PowerController-only.
function parseSceneList(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  // Match `<number>="<text-with-optional-escapes>"`. The body class allows
  // anything except an unescaped quote; `\.` permits backslash escapes
  // (Loxone documents `\"` for literal quote inside the name).
  const re = /(\d+)\s*=\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = Number.parseInt(m[1], 10);
    if (!Number.isFinite(id)) continue;
    // Un-escape Loxone's documented \" and \\ — produce the human-visible name.
    const name = m[2].replace(/\\(.)/g, '$1') || `Scene ${id}`;
    out.push({ id, name });
  }
  return out;
}

// Apply the per-device polarity inversion to a binary sensor reading.
// Sensors (MotionSensor / ContactSensor) carry a single per-endpoint
// boolean `sensorPolarityInverted`; when true, DETECTED ↔ NOT_DETECTED
// swap. Default-on for sensor types because the most common Loxone wiring
// (reed switches, N.C. contacts) reports the *opposite* polarity to
// Alexa's wire convention. Non-string values short-circuit unchanged.
function polarize(state, inverted) {
  if (!inverted) return state;
  if (state === 'DETECTED') return 'NOT_DETECTED';
  if (state === 'NOT_DETECTED') return 'DETECTED';
  return state;
}

// Parse Loxone's `activeMoods` text state into a numeric array of mood IDs.
// Loxone has shipped two formats across versions:
//   - JSON array:        "[1,2]"  or  "[778]"
//   - Bare comma string: "1,2"    or  "778"
// Tolerate both. Returns [] on any parse failure — caller treats that as
// "no moods active", which maps to powerState=OFF.
function parseActiveMoods(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  // JSON-array attempt first; falls through to bare-list parsing on throw.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
        .filter((n) => Number.isFinite(n));
    }
  } catch { /* fall through */ }
  return trimmed
    .replace(/^\[|\]$/g, '')   // strip stray brackets defensively
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

// MVP "device mapping": one Loxone VI exposed as a switch named "Plugin Test".
// In production this comes from data/config.json populated by the picker UI.
function defaultEndpointsForTesting() {
  return [
    {
      endpointId: 'alexa-pluginTest',
      friendlyName: 'Plugin Test',
      displayCategories: ['SWITCH'],
      capabilities: ['PowerController'],
      power: {
        msNo: 1,
        name: 'PluginTest',
        onValue: 'On',
        offValue: 'Off',
      },
    },
  ];
}

module.exports = {
  DirectiveRouter,
  defaultEndpointsForTesting,
  parseActiveMoods,
  parseSceneList,
  parseColorState,
  // Dimmer position↔brightness scaling — state-reporter reuses dimmerToBrightness
  // so the push ChangeReport matches the pull ReportState exactly.
  dimmerToBrightness,
  IMPLEMENTED_CAPABILITIES,
  // LightController v1 constants — state-reporter uses them to derive
  // PowerController.powerState on activeScene changes (OFF iff scene 0)
  // and to choose the right ModeController instance for emission.
  MODE_INSTANCE_LIGHT_SCENE,
  OFF_SCENE_ID,
  // ACControl: fan-speed instance + Loxone↔Alexa mode mapper. State-reporter
  // uses these to build ChangeReports for AC status/mode/fan/temperature.
  MODE_INSTANCE_AC_FAN,
  alexaModeFromAC,
  // Ventilation: speed/mode instances + manual-timer sentinel. State-reporter
  // emits power-state changes derived from the (activeTimerProfile, speed)
  // tuple — needs both constants to recognize the "manual zero" off case.
  RANGE_INSTANCE_VENT_SPEED,
  MODE_INSTANCE_VENT_MODE,
  VENT_TIMER_PROFILE_MANUAL,
  // Radio + ValueSelector + Sequential instance names — state-reporter
  // uses these when emitting ChangeReports for the respective state changes.
  MODE_INSTANCE_RADIO,
  RANGE_INSTANCE_VALUE_SELECTOR,
  MODE_INSTANCE_SEQUENCE,
  // Binary-sensor ModeController — state-reporter uses this to emit
  // the dual ModeController property alongside ContactSensor/MotionSensor.
  MODE_INSTANCE_BINARY_SENSOR,
  // RangeController helpers — exported so state-reporter can apply the
  // same axis-inversion + range-bounds math when emitting ChangeReports.
  BLIND_TYPES,
  RANGE_INSTANCE_BLINDS,
  RANGE_INSTANCE_SLIDER,
  rangeBoundsFor,
  mirrorInRange,
  // Thermostat helpers — same reason: state-reporter needs the per-control
  // temperature scale and Loxone-mode → Alexa-mode mapping to build
  // ChangeReports that match what we declared at Discovery.
  thermostatScaleFor,
  alexaModeFromLoxone,
  // Sensor polarity inversion — state-reporter applies it to every
  // ChangeReport so the live path matches the ReportState resolvers.
  polarize,
  // Audio helpers — state-reporter dispatches on these for the AudioZone
  // state mappings (volume/playState/shuffle/repeat/source/power).
  AUDIO_TYPES,
  TOGGLE_INSTANCE_SHUFFLE,
  MODE_INSTANCE_REPEAT,
  MODE_INSTANCE_SOURCE,
  ALEXA_BY_REPEAT,
  alexaPlaybackStateFromLoxone,
  parseSourceList,
};
