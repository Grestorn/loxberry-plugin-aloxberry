#!/usr/bin/env node
// Unit tests for DevicesConfig — focused on ORPHAN handling (devices whose
// Loxone control was deleted in Loxone Config). The rest of the sanitizer is
// exercised end-to-end on the LoxBerry.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DevicesConfig } = require('../src/devices-config');

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

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

const DEVICES = {
  version: 1,
  globals: { enabled: true, vacationGate: { enabled: false, controlUuid: null } },
  devices: [
    { uuid: 'ctrl-alive', enabled: true, friendlyName: 'Küche Licht',
      displayCategory: 'LIGHT', capabilities: ['PowerController'], msNo: 1 },
    { uuid: 'ctrl-deleted', enabled: true, friendlyName: 'Flur Steckdose',
      displayCategory: 'SWITCH', capabilities: ['PowerController'], msNo: 1 },
  ],
};

// A structure cache stand-in. `known` is the set of control UUIDs Loxone
// still reports; `loaded` mimics hasStructure() (false = we never got a
// structure, so absence proves nothing).
function fakeStructure(known, loaded = true) {
  return {
    hasStructure: () => loaded,
    getControl: (uuid) => (known.includes(uuid) ? { uuid, type: 'Switch' } : null),
  };
}

async function withConfig(structureCache, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aloxberry-devcfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify(DEVICES));
    const cfg = new DevicesConfig({ configDir: dir, log: noopLog, structureCache });
    await cfg.load();
    await fn(cfg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {

// A Gate whose category is GARAGE_DOOR must survive the load untouched. This
// used to be a REMOVED_CATEGORY that the sanitizer silently rewrote to the
// control type's default, and the rewrite is invisible to the user - the
// device simply comes back as an ordinary door with no voice-code prompt.
async function withGarageConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aloxberry-garage-'));
  try {
    fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({
      version: 1,
      globals: { enabled: true, vacationGate: { enabled: false, controlUuid: null } },
      devices: [
        { uuid: 'ctrl-gate', enabled: true, friendlyName: 'Garagentor',
          displayCategory: 'GARAGE_DOOR', capabilities: ['ModeController'], msNo: 1 },
        { uuid: 'ctrl-bell', enabled: true, friendlyName: 'Klingel',
          displayCategory: 'DOORBELL', capabilities: ['PowerController'], msNo: 1 },
      ],
    }));
    const structureCache = {
      hasStructure: () => true,
      getControl: (uuid) => (uuid === 'ctrl-gate' ? { uuid, type: 'Gate' }
                           : uuid === 'ctrl-bell' ? { uuid, type: 'Switch' } : null),
    };
    const cfg = new DevicesConfig({ configDir: dir, log: noopLog, structureCache });
    await cfg.load();
    await fn(cfg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Hand-edited rows where the GARAGE_DOOR category and the capabilities
// disagree. Both directions collapse onto the single arm Amazon actually
// voice-code gates - see _resolveCapabilities for why neither is safe to keep.
async function withCapsConfig(caps, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aloxberry-garagecaps-'));
  try {
    fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({
      version: 1,
      globals: { enabled: true, vacationGate: { enabled: false, controlUuid: null } },
      devices: [{ uuid: 'ctrl-gate', enabled: true, friendlyName: 'Garagentor',
                  displayCategory: 'GARAGE_DOOR', capabilities: caps, msNo: 1 }],
    }));
    const cfg = new DevicesConfig({
      configDir: dir, log: noopLog,
      structureCache: { hasStructure: () => true,
                        getControl: (u) => (u === 'ctrl-gate' ? { u, type: 'Gate' } : null) },
    });
    await cfg.load();
    await fn(cfg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await test('a GARAGE_DOOR row claiming both arms is collapsed to the gated one', async () => {
  await withCapsConfig(['ModeController', 'RangeController'], (cfg) => {
    eq(cfg.list()[0].capabilities.join(','), 'ModeController',
      'RangeController dropped (it would open the door without a voice code)');
    eq(cfg.list()[0].displayCategory, 'GARAGE_DOOR', 'category kept');
  });
});

await test('UPGRADE: a pre-0.7.1 Gate row keeps working instead of turning into a garage door', async () => {
  // Exactly what every install older than 0.7.1 has on disk: back then Gate
  // defaulted to GARAGE_DOOR while still being driven by RangeController.
  // Alexa never gated that combination, so the owner has been using an
  // ordinary position-controlled gate. Promoting it to the ModeController arm
  // would silently make it demand a voice code they have not set — the gate
  // would simply stop opening. Demote the category instead: same behaviour as
  // before the upgrade, and the same result 0.7.1 itself produced.
  await withCapsConfig(['RangeController'], (cfg) => {
    const d = cfg.list()[0];
    eq(d.displayCategory, 'DOOR', 'category demoted, not silently gated');
    eq(d.capabilities.join(','), 'RangeController', 'the gate still works as it did');
    // Same treatment the removed-category migration gets: written back to disk
    // and flagged so the user is told to re-run discovery.
    check(!!cfg.migrationPending, 'counted as a migration (write-back + banner)');
  });
});

await test('GARAGE_DOOR survives the sanitizer; DOORBELL is still migrated away', async () => {
  await withGarageConfig((cfg) => {
    const byUuid = {};
    cfg.list().forEach((d) => { byUuid[d.uuid] = d; });
    eq(byUuid['ctrl-gate'].displayCategory, 'GARAGE_DOOR',
      'GARAGE_DOOR is a supported category, not migrated');
    eq(byUuid['ctrl-gate'].capabilities.join(','), 'ModeController',
      'the ModeController arm is preserved');
    // The other removed categories must keep being migrated - Switch → SWITCH.
    eq(byUuid['ctrl-bell'].displayCategory, 'SWITCH',
      'DOORBELL still migrates to the control type default');
    // And the surviving category must reach the Alexa endpoint list intact.
    const ep = cfg.toEndpoints().find((e) => e.uuid === 'ctrl-gate');
    eq(ep?.displayCategories?.[0], 'GARAGE_DOOR', 'advertised as GARAGE_DOOR');
  });
});

await test('both controls still exist → nothing is treated as an orphan', async () => {
  await withConfig(fakeStructure(['ctrl-alive', 'ctrl-deleted']), (cfg) => {
    eq(cfg.listOrphans().length, 0, 'no orphans');
    eq(cfg.toEndpoints().length, 2, 'both devices advertised');
  });
});

await test('control deleted in Loxone → orphan, and NOT advertised to Alexa', async () => {
  await withConfig(fakeStructure(['ctrl-alive']), (cfg) => {
    const orphans = cfg.listOrphans();
    eq(orphans.length, 1, 'one orphan');
    eq(orphans[0].uuid, 'ctrl-deleted', 'the deleted control is the orphan');
    // The row itself must survive on disk — the user owns that decision.
    eq(cfg.list().length, 2, 'devices.json row is kept, not auto-pruned');
    const ids = cfg.toEndpoints().map((e) => e.uuid);
    eq(ids.length, 1, 'only the live device is advertised');
    eq(ids[0], 'ctrl-alive', 'the surviving device is the live one');
  });
});

await test('no structure yet → fail open, advertise everything', async () => {
  // Miniserver never reached: getControl() returns null for EVERY uuid.
  // Treating that as "all controls deleted" would silently unpublish the
  // user's whole device set, so hasStructure() gates the check.
  await withConfig(fakeStructure([], false), (cfg) => {
    eq(cfg.listOrphans().length, 0, 'no orphans claimed without a structure');
    eq(cfg.toEndpoints().length, 2, 'both devices still advertised');
  });
});

await test('no structure cache wired at all → fail open', async () => {
  await withConfig(null, (cfg) => {
    eq(cfg.listOrphans().length, 0, 'no orphans');
    eq(cfg.toEndpoints().length, 2, 'both devices still advertised');
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

})();
