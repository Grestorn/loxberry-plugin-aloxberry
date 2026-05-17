#!/usr/bin/env node
// Mock for lox-getconfig.pl — emits a deterministic 2-miniserver fixture.
// Matches the helper's exit-code contract.
'use strict';

const args = process.argv.slice(2);
const withCreds = args.includes('--with-credentials');
const unexpected = args.filter((a) => a !== '--with-credentials');

if (unexpected.length) {
  process.stderr.write('usage: mock-lox-getconfig.cjs [--with-credentials]\n');
  process.exit(2);
}

const make = (overrides) => ({
  msNo: 1,
  name: 'TestMS',
  host: 'miniserver.test',
  portHttp: 80,
  portHttps: 443,
  preferHttps: true,
  scheme: 'https',
  useCloudDNS: false,
  cloudUrl: '',
  ...overrides,
});

const fixture = [
  make({ msNo: 1, name: 'MainMS' }),
  make({ msNo: 2, name: 'GuestHouseMS', host: 'guest.test', preferHttps: false, scheme: 'http' }),
];

if (withCreds) {
  fixture[0].username = 'admin';
  fixture[0].password = 'mock-password-do-not-log';
  fixture[1].username = 'guest';
  fixture[1].password = 'another-mock-password';
}

process.stdout.write(JSON.stringify(fixture) + '\n');
process.exit(0);
