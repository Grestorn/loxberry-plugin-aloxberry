#!/usr/bin/env node
// End-to-end test: LoxoneCommandClient → real lox-send.pl → real LoxBerry::IO → real Miniserver.
// Run on the LoxBerry.  Targets the PluginTest VI on Miniserver 1.
//
// Verifies the full step-3 + step-4 stack:
//   - Node spawns `perl` (real interpreter on the Pi)
//   - lox-send.pl imports LoxBerry::IO
//   - LoxBerry::IO writes to the Miniserver
//   - The wrapper captures stdout/stderr/exitcode/duration correctly
'use strict';

const { LoxoneCommandClient } = require('../src/loxone-command');

// Minimal log stub that supports .child() for the wrapper.
const log = {
  debug(...a) { console.log('DEBUG', ...a); },
  info(...a)  { console.log('INFO',  ...a); },
  warn(...a)  { console.log('WARN',  ...a); },
  error(...a) { console.log('ERROR', ...a); },
  child() { return this; },
};

(async () => {
  const client = new LoxoneCommandClient({ log });

  const cases = [
    { label: 'happy path',          msNo: 1,  name: 'PluginTest',                         value: `e2e-${Date.now()}` },
    { label: 'nonexistent VI',      msNo: 1,  name: '__aloxberry_e2e_nonexistent_vi__',     value: 'on' },
    { label: 'nonexistent ms',      msNo: 99, name: 'anything',                           value: 'x' },
  ];

  for (const c of cases) {
    console.log(`\n---- ${c.label}: ms=${c.msNo} name=${c.name} value=${c.value}`);
    const r = await client.send(c);
    console.log(JSON.stringify(r, null, 2));
  }
})();
