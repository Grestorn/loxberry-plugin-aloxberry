#!/usr/bin/env node
// Mock for lox-send.pl — simulates the helper's three exit-code contract
// without needing Perl or LoxBerry. Used by test-loxone-command.cjs.
//
// Behavior driven by argv[3] (the "name" field):
//   "ok"   → stdout "ok",  exit 0
//   "fail" → stdout "fail: simulated miniserver failure", exit 1
//   "hang" → never exits (lets the wrapper time out)
//   "noisy-stderr-ok"   → stdout "ok", stderr "simulated chatter", exit 0
//   "noisy-stderr-fail" → stdout "fail: ...", stderr "simulated diagnostic", exit 1
// Wrong argv count → usage to stderr, exit 2 (matches lox-send.pl).
'use strict';

if (process.argv.length !== 5) {
  process.stderr.write('usage: mock-lox-send.cjs <ms> <name> <value>\n');
  process.exit(2);
}

const name = process.argv[3];

switch (name) {
  case 'fail':
    process.stdout.write('fail: simulated miniserver failure\n');
    process.exit(1);
  case 'hang':
    // Park here until killed; no stdout/exit.
    setTimeout(() => {}, 60_000);
    break;
  case 'noisy-stderr-ok':
    process.stderr.write('simulated chatter\n');
    process.stdout.write('ok\n');
    process.exit(0);
  case 'noisy-stderr-fail':
    process.stderr.write('simulated diagnostic from helper\n');
    process.stdout.write('fail: simulated failure with stderr\n');
    process.exit(1);
  default:
    process.stdout.write('ok\n');
    process.exit(0);
}
