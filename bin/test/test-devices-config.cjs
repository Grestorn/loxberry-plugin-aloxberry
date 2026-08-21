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
