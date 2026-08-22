'use strict';

// devices.json reader and watcher.
//
// devices.json lives in $LBPCONFIG/alexa-aloxberry/ — preserved across plugin
// upgrades by LoxBerry's installer. The CGI's "Devices" picker writes it;
// the daemon watches via chokidar and hot-reloads on every save.
//
// Schema (version 1):
//   {
//     "version": 1,
//     "globals": {
//       // Master switch. When false, the daemon refuses to talk to the
//       // bridge at all (no inbound directives, no outbound state).
//       "enabled": true,
//       // Soft-gate: when the watched Loxone control/state is ON, the
//       // daemon BLOCKS Alexa→Miniserver writes but still ALLOWS state
//       // reports back to Alexa. The user wires "<pause condition> → that
//       // control ON" in Loxone Config (e.g. a Virtual Output / Merker
//       // driven by a custom Betriebsart). controlUuid may be a control
//       // UUID (we read its active/value state) or a raw state UUID.
//       "vacationGate": {
//         "enabled": false,
//         "controlUuid": null
//       }
//     },
//     "devices": [
//       {
//         "uuid":            "<loxone-uuid>",
//         "enabled":         true,
//         "friendlyName":    "Wohnzimmer Decke",
//         "displayCategory": "LIGHT",
//         "capabilities":    ["PowerController"],
//         "msNo":            1,
//         "addedAt":         "2026-...",
//         "updatedAt":       "2026-..."
//       }
//     ]
//   }
//
// The picker writes `uuid` as the Loxone uuidAction (URL segment used by
// jdev/sps/io/<uuid>). The friendlyName is the exact string the daemon
// hands to Alexa as the device's friendly name — typically pre-filled by
// the picker as "<room> <control name>" but freely editable.
//
// ORPHANS ("zombies")
// -------------------
// Deleting a control in Loxone Config does NOT touch devices.json — nothing
// on the Miniserver knows this plugin exists. The row survives, pointing at
// a UUID that no longer resolves. Such a row is an *orphan*, and it is
// deliberately KEPT on disk rather than auto-pruned: the user picked that
// device, so only the user removes it (and a hand-repair in Loxone Config
// can make it valid again).
//
// What an orphan must not do is stay advertised to Alexa. Alexa never drops
// an endpoint just because a Discover.Response stopped listing it — but it
// *does* re-add anything a Discover.Response does list. So an orphan still
// present in the endpoint list makes a device the user deleted in the Alexa
// app reappear on the next discovery, forever, while being unable to answer
// a single directive. toEndpoints() therefore filters orphans out, and the
// picker UI lists them unconditionally so the user can see and remove them.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const EventEmitter = require('node:events');
const chokidar = require('chokidar');
const { alexaInfoForType } = require('./structure');

const SCHEMA_VERSION = 1;
// Validate display categories against what Alexa actually accepts. Picker
// must pre-restrict, but defence in depth here means a hand-edited devices.json
// can't crash the directive router by claiming an invalid category.
// Universal whitelist of Alexa displayCategories the daemon will accept.
// Picker-side per-type filtering (allowedCategories in structure.js) narrows
// this further by control type, so a user setting a Switch to `THERMOSTAT`
// isn't possible through the UI — but this set stays permissive so a
// hand-edited devices.json can use anything Alexa documents as valid.
// Order matters for the picker dropdown layout: most-common first.
const VALID_CATEGORIES = new Set([
  // Lighting / generic on-off
  'LIGHT', 'SWITCH', 'OUTLET', 'SMARTPLUG', 'FAN',
  // Climate
  'THERMOSTAT', 'AIR_CONDITIONER', 'VENT',
  // Sensors
  'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'AIR_QUALITY_MONITOR',
  'CONTACT_SENSOR', 'MOTION_SENSOR',
  // Openings
  'INTERIOR_BLIND', 'EXTERIOR_BLIND', 'DOOR', 'GARAGE_DOOR',
  // Audio / video
  'SPEAKER', 'STREAMING_DEVICE', 'MUSIC_SYSTEM',
  // Scenes / hubs / fallback
  'SCENE_TRIGGER', 'ACTIVITY_TRIGGER', 'HUB',
  'OTHER',
]);

// Categories that were once selectable but have been removed because Alexa's
// certification rules require interfaces we can't provide from a Loxone-only
// daemon:
//   DOORBELL    — needs Alexa.DoorbellEventSource (a doorbell announces
//                 itself; the user does not voice-control it). Pure
//                 PowerController/SceneController endpoints render a
//                 doorbell tile that does nothing useful in Routines.
//   CAMERA      — needs Alexa.CameraStreamController + an MJPEG/RTSP feed.
//                 The daemon has no way to provide one.
//
// On load, existing devices.json entries with one of these categories are
// silently migrated to their control type's default (e.g. Switch with
// DOORBELL → SWITCH). Migration is forensic-logged but not surfaced in the
// UI. The corrected category is persisted back to disk on the next CGI save.
//
// GARAGE_DOOR was on this list until the Gate type learned the real
// Alexa.ModeController + GarageDoor.Position shape (see structure.js). It is
// now a supported opt-in category, so it must NOT be migrated away. Note the
// one-way consequence for anyone who set it before that: their row was
// already rewritten to DOOR on an earlier load, and re-selecting GARAGE_DOOR
// is a deliberate user action — we do not try to resurrect the old value.
const REMOVED_CATEGORIES = new Set(['DOORBELL', 'CAMERA']);

const DEFAULT_GLOBALS = Object.freeze({
  enabled: true,
  vacationGate: { enabled: false, controlUuid: null },
});

class DevicesConfig extends EventEmitter {
  constructor({ configDir, log, structureCache = null }) {
    super();
    this.path = path.join(configDir, 'devices.json');
    this.log = log.child({ component: 'devices-config' });
    // structureCache is OPTIONAL — when present, removed-category migration
    // resolves to the control type's default (Gate → DOOR); when absent
    // (tests, cold first install before LoxAPP3.json has been fetched),
    // migration falls back to 'OTHER'. Missing structure can never crash
    // the load — see _migrateRemovedCategory.
    this.structureCache = structureCache;
    this.devices = [];                                    // sanitized list
    // Memo for _logOrphanChange — the last orphan set we logged, so the
    // warning fires on change instead of on every rebuild.
    this._lastOrphanKey = null;
    this.globals = { ...DEFAULT_GLOBALS,
                     vacationGate: { ...DEFAULT_GLOBALS.vacationGate } };
    this.lastLoadAt = null;
    this.watcher = null;
    // Migration banner state. Set to { count, since } after a load with
    // category migrations applied; cleared when a subsequent user CGI
    // save (an external write that lands on disk with clean data) signals
    // implicit acknowledgment. index.js mirrors this to state.json so the
    // CGI's devices page can render the "Alexa, discover my devices"
    // banner.
    this.migrationPending = null;
    // Deadline (ms since epoch) before which any chokidar event is treated
    // as the response to our own _persistAfterMigration write, not a user
    // save. A timestamp window (not a counter) because the atomic write+
    // rename can produce more than one event (chokidar may emit 'unlink'
    // then 'add', or 'change' alone, platform-dependent) — a counter would
    // be exhausted by the first event and let the second prematurely clear
    // the banner. 2 s is generous vs chokidar's 300 ms awaitWriteFinish
    // debounce plus delivery jitter, while still narrow enough that a
    // real user CGI save in normal operation won't fall inside it.
    this._suppressClearUntil = 0;
  }

  async start() {
    await this.load();
    // Watch even when the file doesn't exist yet — chokidar handles the
    // ENOENT → exists transition (e.g. when the CGI saves for the first
    // time after a fresh install).
    this.watcher = chokidar.watch(this.path, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.watcher.on('add', () => this._reload('add'));
    this.watcher.on('change', () => this._reload('change'));
    this.watcher.on('unlink', () => this._reload('unlink'));
  }

  async stop() {
    if (this.watcher) {
      try { await this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
  }

  async _reload(eventName) {
    const previous = this.devices;
    // Within the post-self-write window any reload reflects OUR migration
    // write, not a user save — don't clear the banner. After the window
    // expires, every reload is a real external write.
    const wasOurWrite = Date.now() < this._suppressClearUntil;
    await this.load({ wasOurWrite });
    this.log.info(
      { event: eventName, count: this.devices.length, wasOurWrite },
      'devices.json reloaded',
    );
    this.emit('change', { devices: this.devices, previous });
  }

  async load({ wasOurWrite = false } = {}) {
    try {
      const text = await fsp.readFile(this.path, 'utf8');
      const data = JSON.parse(text);
      // Counter that _resolveDisplayCategory increments for each removed-
      // category migration it applies in this load. After sanitize, if > 0
      // we persist the corrected file so the Perl CGI (which reads the
      // file directly to populate the picker) sees clean data instead of
      // the dead category. Without this write-back the daemon's in-memory
      // state is correct but the picker keeps showing the stale value.
      this._migratedThisLoad = 0;
      this.devices = this._sanitizeDevices(data);
      this.globals = this._sanitizeGlobals(data);
      this.lastLoadAt = new Date().toISOString();
      if (this._migratedThisLoad > 0) {
        await this._persistAfterMigration(this._migratedThisLoad);
        // Idempotent: only emit on the FIRST load where a banner becomes
        // pending. Subsequent self-write echos won't re-fire (file is
        // clean post-persist).
        if (!this.migrationPending) {
          this.migrationPending = {
            count: this._migratedThisLoad,
            since: this.lastLoadAt,
          };
          this.emit('migrated', this.migrationPending);
        }
      } else if (!wasOurWrite && this.migrationPending) {
        // Clean external write after a pending migration → user saved via
        // the CGI picker, which we treat as implicit acknowledgment.
        // Banner clears.
        this.migrationPending = null;
        this.emit('migration-acknowledged');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn({ err: err.message }, 'devices.json load failed — treating as empty');
      }
      this.devices = [];
      this.globals = { ...DEFAULT_GLOBALS,
                       vacationGate: { ...DEFAULT_GLOBALS.vacationGate } };
      this.lastLoadAt = new Date().toISOString();
    }
  }

  // Write the in-memory sanitized state back to devices.json after a removed-
  // category migration. Atomic write (tmp + rename, mode 0600) matches the
  // Perl CGI writer's idiom so a concurrent CGI read never sees a half-
  // written file. The write triggers the chokidar watcher, which fires
  // _reload → load → sanitize on a now-clean file (zero migrations) →
  // no second write. Two-pass stable, no loop.
  //
  // Best-effort: if the write fails (permissions, full disk, …) the in-
  // memory state is still correct, only the picker keeps showing stale
  // values. Logged at warn level, no throw.
  async _persistAfterMigration(count) {
    const payload = {
      version: SCHEMA_VERSION,
      globals: this.globals,
      devices: this.devices,
    };
    const json = JSON.stringify(payload, null, 2) + '\n';
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fsp.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, this.path);
      // chokidar will fire shortly from this write — possibly more than
      // one event (atomic rename can emit unlink+add on some platforms).
      // Open a 2 s window during which every reload is treated as ours
      // so the banner doesn't get prematurely cleared by an echo of our
      // own write. See `_suppressClearUntil` rationale in the constructor.
      this._suppressClearUntil = Date.now() + 2000;
      this.log.info({ migratedCount: count }, 'devices.json rewritten after category migration');
    } catch (err) {
      this.log.warn({ err: err.message }, 'failed to persist devices.json after migration — picker may still show stale category until next user save');
      // Best-effort tmp cleanup.
      try { await fsp.unlink(tmp); } catch { /* ignore */ }
    }
  }

  _sanitizeDevices(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.devices)) return [];
    if (data.version !== SCHEMA_VERSION) {
      this.log.warn({ have: data.version, expect: SCHEMA_VERSION }, 'devices.json schema version mismatch — best-effort load');
      // Don't refuse to load — try anyway. Future migration code lands here.
    }
    const out = [];
    for (const d of data.devices) {
      if (!d || typeof d !== 'object') continue;
      if (typeof d.uuid !== 'string' || d.uuid.length < 8) continue;
      const { displayCategory, capabilities } = this._resolveArm(d);
      out.push({
        uuid:            d.uuid,
        enabled:         d.enabled !== false,                                 // default true
        friendlyName:    String(d.friendlyName || '').trim(),
        displayCategory,
        capabilities,
        // Reverse the RangeController axis ("100 means closed" vs "100 means
        // open"). Per-device override of the type's default; missing field
        // means "use default" — but since the picker always writes the
        // resolved value, in practice this is non-null for every RangeController
        // device. Daemon reads this verbatim; never re-derives from type.
        rangeAxisInverted: d.rangeAxisInverted === true,
        // ThermostatController per-device write semantics. When useOverride
        // is true, SetTargetTemperature goes through Loxone's override
        // command with an auto-expire of overrideHours; otherwise it writes
        // setComfortTemperature (permanent change to the schedule).
        // overrideHours is clamped to a sensible range so a malformed save
        // (or a hand-edit) can't push an "override for 100 years" timer.
        thermostatUseOverride:   d.thermostatUseOverride === true,
        thermostatOverrideHours: clampOverrideHours(d.thermostatOverrideHours),
        // TimedSwitch "trigger the timer instead of switching on permanently".
        // When true, PowerController.TurnOn sends `pulse` (timed) rather than
        // `On` (permanent). Default false preserves the historical permanent-on
        // behaviour for existing devices.json entries. Only meaningful for
        // TimedSwitch endpoints; ignored otherwise.
        timedSwitchPulse:        d.timedSwitchPulse === true,
        // Step size used for AdjustVolume when Alexa sends volumeDefault=true
        // ("louder"/"quieter" with no explicit amount). Clamped 1..50 so a
        // hand-edited devices.json can't push a runaway step.
        audioVolumeStep:         clampVolumeStep(d.audioVolumeStep),
        // Sensor polarity inversion. When true, DETECTED ↔ NOT_DETECTED
        // swap in every emission. Only meaningful for ContactSensor /
        // MotionSensor endpoints; ignored otherwise. Default true matches
        // the most-common Loxone reed/contact wiring (active=1 = open).
        sensorPolarityInverted:  d.sensorPolarityInverted !== false,
        // Hours that a Ventilation manual-timer override applies for.
        // Loxone has no "permanent speed" command; Alexa writes always
        // wrap with setTimer/{N*3600}/.../-1. Only meaningful for
        // Ventilation endpoints; ignored otherwise. Default 24h.
        ventilationOverrideHours: clampVentilationHours(d.ventilationOverrideHours),
        // Custom labels for the binary-sensor ModeController option
        // (PresenceDetector / WindowMonitor / InfoOnlyDigital with the
        // ModeController role enabled). When blank, Discovery falls back
        // to generic "Active"/"Inactive". Length-capped so a hand-edit
        // can't push an essay into Alexa's slot name.
        modeLabelActive:   clampLabel(d.modeLabelActive),
        modeLabelInactive: clampLabel(d.modeLabelInactive),
        msNo:            Number.isFinite(d.msNo) ? d.msNo : 1,
        addedAt:         d.addedAt || null,
        updatedAt:       d.updatedAt || null,
      });
    }
    return out;
  }

  // Resolve the (category, capabilities) pair for a stored device.
  //
  // The two fields are independent everywhere except on a garage door, where
  // Alexa applies its voice-code challenge only to the exact combination
  // GARAGE_DOOR + ModeController(GarageDoor.Position). Any other pairing is a
  // misconfiguration, and both misconfigurations are dangerous in the same
  // quiet way — the device still works, it just isn't protected — so they are
  // resolved here rather than passed through.
  //
  // GARAGE_DOOR without ModeController → the CATEGORY is demoted to DOOR.
  //   The device keeps behaving exactly as it did, as an ordinary opening with
  //   a position range. It matters that this direction demotes the category
  //   rather than promoting the capability: this is the shape every pre-0.7.1
  //   install has on disk (Gate defaulted to GARAGE_DOOR back then), and
  //   silently converting those gates into voice-code garage doors would stop
  //   them opening until their owner worked out that they now had to set a
  //   code in the Alexa app. Switching on a security feature behind someone's
  //   back is not a favour. It is also the same demotion 0.7.1 already
  //   performed, so upgrading from before it lands in the same place either
  //   way.
  //
  // GARAGE_DOOR with ModeController AND extras → the EXTRAS are dropped.
  //   Here the user is genuinely asking for a garage door, so the fix keeps
  //   the gated arm. A RangeController left alongside it would hand Alexa a
  //   second way to open the same gate — "set the garage door to 100 percent"
  //   — carrying no challenge at all, while the prompt on "open" made the
  //   whole thing look protected.
  //
  // The picker cannot produce either state (structure.js couples the two), so
  // in practice this fires only on an upgrade or a hand-edited file.
  _resolveArm(d) {
    const displayCategory = this._resolveDisplayCategory(d);
    const caps = Array.isArray(d.capabilities)
      ? d.capabilities.filter((c) => typeof c === 'string')
      : [];
    if (displayCategory !== 'GARAGE_DOOR') return { displayCategory, capabilities: caps };

    if (!caps.includes('ModeController')) {
      this.log.info(
        { uuid: d.uuid, from: displayCategory, to: 'DOOR', capabilities: caps },
        'GARAGE_DOOR without the ModeController arm cannot be voice-code gated by Alexa — '
        + 'demoted to DOOR; re-select GARAGE_DOOR on the Devices page to get the code prompt',
      );
      // Counted as a migration so the corrected value is written back to disk
      // and the "re-run discovery" banner appears — exactly what the 0.7.1
      // removal of this category did for the same rows.
      this._migratedThisLoad += 1;
      return { displayCategory: 'DOOR', capabilities: caps };
    }

    if (caps.length === 1) return { displayCategory, capabilities: caps };
    this.log.warn(
      { uuid: d.uuid, from: caps, to: ['ModeController'] },
      'GARAGE_DOOR endpoint must expose only ModeController (GarageDoor.Position) — '
      + 'other capabilities dropped; they would give Alexa an opening path that '
      + 'skips the voice code',
    );
    return { displayCategory, capabilities: ['ModeController'] };
  }

  // Resolve a stored device's displayCategory through the removed-category
  // migration and the universal whitelist. Three outcomes:
  //   1. Removed category → look up the control's type in structureCache and
  //      use its TYPE_MAP default (Gate → DOOR, Switch+DOORBELL → SWITCH).
  //      If structureCache is unavailable or doesn't know the control,
  //      fall back to 'OTHER'.
  //   2. Otherwise-valid category → pass through unchanged.
  //   3. Anything else → 'OTHER' (defence in depth against hand-edited JSON).
  // Hits on outcome (1) are logged so a forensic trail exists; the UI is
  // intentionally not notified — the next CGI save persists the migrated
  // value transparently.
  _resolveDisplayCategory(d) {
    const stored = d.displayCategory;
    if (REMOVED_CATEGORIES.has(stored)) {
      const control = this.structureCache?.getControl(d.uuid);
      const typeInfo = control ? alexaInfoForType(control.type) : null;
      const migrated = typeInfo?.category && VALID_CATEGORIES.has(typeInfo.category)
        ? typeInfo.category
        : 'OTHER';
      this.log.info(
        { uuid: d.uuid, from: stored, to: migrated, type: control?.type || null },
        'displayCategory no longer supported — migrated to control type default',
      );
      // Counter read by load() — drives the write-back AND the banner
      // 'migrated' event. Initialized to 0 at the top of load(), so the
      // ++ here is safe even when load is called multiple times.
      this._migratedThisLoad += 1;
      return migrated;
    }
    return VALID_CATEGORIES.has(stored) ? stored : 'OTHER';
  }

  _sanitizeGlobals(data) {
    const g = (data && typeof data === 'object' && data.globals && typeof data.globals === 'object')
      ? data.globals : {};
    const vg = (g.vacationGate && typeof g.vacationGate === 'object') ? g.vacationGate : {};
    // vacationGate now watches a user-chosen Loxone control/state (the user
    // wires "<pause condition> → that control ON" in Loxone Config). The
    // legacy `operatingModeIndex` is intentionally dropped: it could never
    // work for custom/system Betriebsarten (no Loxone read API exists).
    const controlUuid = (typeof vg.controlUuid === 'string' && vg.controlUuid.trim())
      ? vg.controlUuid.trim() : null;
    return {
      enabled: g.enabled !== false,                       // default true (fail-safe: open)
      vacationGate: {
        enabled: vg.enabled === true,                     // default false
        controlUuid,                                      // null = gate inert
      },
    };
  }

  list() {
    return this.devices.slice();
  }

  // Read-only view of the global gatekeeper config. Daemon-side enforcement
  // (refusing directives when enabled=false, blocking writes when vacation
  // gate is active) is wired up by the caller in the next phase.
  getGlobals() {
    return JSON.parse(JSON.stringify(this.globals));
  }

  // Devices whose Loxone control no longer exists — see the ORPHAN section
  // in the file header. Returns [] whenever the structure cache can't answer
  // negative questions (no structure at all), so a Miniserver we simply
  // haven't reached yet never gets mistaken for a Miniserver with every
  // control deleted.
  listOrphans() {
    if (!this.structureCache?.hasStructure?.()) return [];
    return this.devices.filter((d) => !this.structureCache.getControl(d.uuid));
  }

  // Translate the sanitized devices.json into the endpoint shape that
  // DirectiveRouter consumes. Only enabled devices appear. friendlyName
  // is used as-is — the picker writes the room-prefixed name directly.
  //
  // Orphans are skipped: they can't serve a directive, and advertising them
  // is what resurrects endpoints the user deleted in the Alexa app. The skip
  // is logged (once per set change) because it is behaviour the user did not
  // ask for and may be looking for an explanation of.
  toEndpoints() {
    const orphans = new Set(this.listOrphans().map((d) => d.uuid));
    this._logOrphanChange(orphans);
    return this.devices
      .filter((d) => d.enabled && d.friendlyName && !orphans.has(d.uuid))
      .map((d) => ({
        endpointId: endpointIdFor(d.uuid),
        uuid:       d.uuid,
        msNo:       d.msNo,
        friendlyName: d.friendlyName,
        description:  `${d.friendlyName} (Loxone)`,
        displayCategories: [d.displayCategory],
        capabilities: d.capabilities,
        // Pass-through so the RangeController handler/state resolver can
        // honor the user's axis preference without consulting the structure.
        rangeAxisInverted: d.rangeAxisInverted === true,
        // ThermostatController override settings (only meaningful for
        // IRoomControllerV2 endpoints). The handler reads both fields.
        thermostatUseOverride:   d.thermostatUseOverride === true,
        thermostatOverrideHours: clampOverrideHours(d.thermostatOverrideHours),
        // TimedSwitch timed-trigger flag — handler reads it in _handlePower.
        timedSwitchPulse:        d.timedSwitchPulse === true,
        // Volume step (Speaker AdjustVolume) — only meaningful for
        // AudioZone endpoints. Handler reads at directive time.
        audioVolumeStep:         clampVolumeStep(d.audioVolumeStep),
        // Sensor polarity (Motion/Contact) — daemon swaps DETECTED ↔
        // NOT_DETECTED when true. Default true; ignored for non-sensor types.
        sensorPolarityInverted:  d.sensorPolarityInverted !== false,
        // Ventilation manual-timer duration (hours). Handler converts to
        // seconds at directive time. Only Ventilation handlers read this.
        ventilationOverrideHours: clampVentilationHours(d.ventilationOverrideHours),
        // Binary-sensor ModeController labels — only meaningful when the
        // device has ModeController in its caps AND is one of the
        // binary-sensor types. Daemon reads these at Discovery time.
        modeLabelActive:   clampLabel(d.modeLabelActive),
        modeLabelInactive: clampLabel(d.modeLabelInactive),
      }));
  }

  // Log orphan skips at most once per distinct set. toEndpoints() runs on
  // every devices.json save AND every structure refresh, so an unconditional
  // log line would repeat the same warning indefinitely.
  _logOrphanChange(orphanUuids) {
    const key = [...orphanUuids].sort().join(',');
    if (key === this._lastOrphanKey) return;
    this._lastOrphanKey = key;
    if (orphanUuids.size === 0) return;
    const names = this.devices
      .filter((d) => orphanUuids.has(d.uuid))
      .map((d) => d.friendlyName || d.uuid);
    this.log.warn(
      { count: orphanUuids.size, uuids: [...orphanUuids], names },
      'device(s) point at Loxone controls that no longer exist — not advertised to Alexa; '
      + 'remove them on the Devices page (and in the Alexa app)',
    );
  }
}

// Bounded sanitizer for the override-duration setting. Range is
// 1..168 hours (1 hour to 1 week) — anything outside collapses to the
// 12-hour default. Missing/NaN also defaults. The handler never sees an
// invalid number, so it can math on this verbatim.
function clampOverrideHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return 12;
  return Math.max(1, Math.min(168, Math.round(n)));
}

// Same bounds as the thermostat override, but a higher default (24h vs
// 12h). Rationale: ventilation overrides are "set and forget" — the user
// usually wants the boost or shutdown to last the rest of the day, not
// to time out mid-afternoon. Defensive clamp also matches Loxone's
// setTimer interval limits (seconds-precision; days are well within range).
function clampVentilationHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return 24;
  return Math.max(1, Math.min(168, Math.round(n)));
}

// Free-text label sanitizer for the binary-sensor ModeController custom
// labels (Active/Inactive). Trims whitespace, caps at 64 chars (Alexa's
// own mode-name length limit is generous but we want to keep the picker
// UI readable). Empty string is allowed and treated by Discovery as
// "use the generic fallback".
function clampLabel(s) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, 64);
}

// Volume-step bound: 1..50. Step of 0 would make "louder" a no-op; step
// over 50 means two voice commands cover the entire range. 5 is the
// out-of-box default and matches Loxone's app-side typical config.
function clampVolumeStep(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(50, Math.round(n)));
}

// Convert a Loxone uuid into the Alexa endpointId we expose at Discovery
// time. Two transforms:
//   - Prefix with "alexa-" (so we can distinguish our IDs from anything
//     else Alexa may have seen across skills).
//   - Sanitize: Alexa's endpointId regex is [A-Za-z0-9_=#;:?@&\-]{1,256}.
//     Loxone sub-control UUIDs contain '/' (e.g. parentUuid/AI1), which
//     Alexa silently rejects at Discovery time (the endpoint just doesn't
//     appear in the user's device list). Map '/' → '_' so sub-controls
//     survive Discovery. The reverse mapping is never needed — internally
//     we look up endpoints by the converted endpointId via a Map, and
//     Loxone commands always use the original uuid stored on the endpoint
//     object (NOT the endpointId).
//
// Worth noting: this is purely a presentation-layer rename. The picker
// keeps writing the original slash-containing uuid into devices.json, and
// lox-control.pl receives the original uuid for its `jdev/sps/io/<uuid>`
// URL path. Only the Alexa-visible identifier is transformed.
function endpointIdFor(uuid) {
  return 'alexa-' + String(uuid).replace(/\//g, '_');
}

module.exports = { DevicesConfig, SCHEMA_VERSION, VALID_CATEGORIES, endpointIdFor };
