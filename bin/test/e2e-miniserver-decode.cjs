#!/usr/bin/env node
// Step 5e end-to-end: subscribe + decode every binary frame.
// Verifies the decoder works on FULL initial-dump frames (~2200 states).
// Output is value-summary only — no UUIDs leaked into transcripts.
'use strict';

const crypto = require('node:crypto');
const { loadWithCredentials } = require('../src/miniserver-config');
const { fetchPublicKey } = require('../src/miniserver-probe');
const { MiniserverWsClient } = require('../src/miniserver-ws');
const { decodeEventPayload } = require('../src/miniserver-events');
const c = require('../src/miniserver-crypto');

const log = {
  debug() {}, info() {}, warn(o, m) { console.log('WARN', m, o ?? ''); },
  error(o, m) { console.log('ERROR', m, o ?? ''); },
  child() { return this; },
};

const DAEMON_UUID = '6c6f7868-6f6d-6500-616c6578612d6873';
const CLIENT_INFO = encodeURIComponent('aloxberry-daemon');
const PERMISSION_APP = 4;
const OBSERVE_MS = 5000;

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }

(async () => {
  const [ms] = await loadWithCredentials();
  const { username, password } = ms.getCredentialsForAuth();
  const pem = await fetchPublicKey(ms);
  const publicKey = crypto.createPublicKey(pem);

  console.log(`# auth + subscribe on ${ms.host}`);
  const client = new MiniserverWsClient({ msConfig: ms, publicKey, log });
  await client.start();
  const k2 = await client.sendEncrypted(`jdev/sys/getkey2/${username}`);
  const { key, salt, hashAlg } = k2.LL.value;
  const pwHash = c.passwordHash(password, salt, hashAlg);
  const hash = c.userHmac(key, username, pwHash, hashAlg);
  const jwt = await client.sendEncrypted(
    `jdev/sys/getjwt/${hash}/${username}/${PERMISSION_APP}/${DAEMON_UUID}/${CLIENT_INFO}`,
  );
  check(jwt?.LL?.Code === '200', 'JWT acquired');

  const totals = { value: 0, text: 0, daytimer: 0, weather: 0 };
  const decodeErrors = [];
  // Sample stats: track value distribution.
  const valueStats = { zeros: 0, positives: 0, negatives: 0, fractional: 0, big: 0 };
  // Sample a few example shapes (NO actual UUIDs or text — just lengths/types)
  const textLengthHistogram = { tiny: 0, short: 0, mediumKB: 0, bigKB: 0 };

  client.on('binary-payload', ({ identifier, data }) => {
    try {
      const decoded = decodeEventPayload(identifier, data);
      if (decoded.kind === 'value') {
        totals.value += decoded.events.length;
        for (const ev of decoded.events) {
          if (ev.value === 0) valueStats.zeros++;
          else if (ev.value > 0) valueStats.positives++;
          else valueStats.negatives++;
          if (Number.isFinite(ev.value) && ev.value !== Math.trunc(ev.value)) valueStats.fractional++;
          if (Math.abs(ev.value) > 1000) valueStats.big++;
        }
      } else if (decoded.kind === 'text') {
        totals.text += decoded.events.length;
        for (const ev of decoded.events) {
          const L = ev.text.length;
          if (L <= 4)       textLengthHistogram.tiny++;
          else if (L <= 64) textLengthHistogram.short++;
          else if (L <= 1024) textLengthHistogram.mediumKB++;
          else              textLengthHistogram.bigKB++;
        }
      } else if (decoded.kind === 'daytimer') {
        totals.daytimer += decoded.events.length;
      } else if (decoded.kind === 'weather') {
        totals.weather += decoded.events.length;
      }
    } catch (err) {
      decodeErrors.push({ identifier, length: data.length, msg: err.message });
    }
  });

  await client.subscribeBinaryEvents();
  console.log(`\n# observing for ${OBSERVE_MS / 1000}s…`);
  await new Promise((r) => setTimeout(r, OBSERVE_MS));

  console.log('\n# decoded totals:');
  console.log(`  value states     = ${totals.value}`);
  console.log(`  text states      = ${totals.text}`);
  console.log(`  daytimer entries = ${totals.daytimer}`);
  console.log(`  weather entries  = ${totals.weather}`);

  console.log('\n# value distribution:');
  console.log(`  zeros        = ${valueStats.zeros}`);
  console.log(`  positives    = ${valueStats.positives}`);
  console.log(`  negatives    = ${valueStats.negatives}`);
  console.log(`  fractional   = ${valueStats.fractional}`);
  console.log(`  |v| > 1000   = ${valueStats.big}`);

  console.log('\n# text length histogram:');
  console.log(`  tiny (≤4)        = ${textLengthHistogram.tiny}`);
  console.log(`  short (5-64)     = ${textLengthHistogram.short}`);
  console.log(`  medium (65-1024) = ${textLengthHistogram.mediumKB}`);
  console.log(`  big (>1024)      = ${textLengthHistogram.bigKB}`);

  check(decodeErrors.length === 0, `decoder errors (${decodeErrors.length})`);
  if (decodeErrors.length > 0) {
    for (const e of decodeErrors.slice(0, 5)) console.log(`    error: id=${e.identifier} len=${e.length} ${e.msg}`);
  }
  check(totals.value > 0, 'at least one value state decoded');
  check(totals.text > 0, 'at least one text state decoded');

  await client.stop();
  await new Promise((r) => setTimeout(r, 200));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`\nfatal: ${err.message}`);
  process.exit(1);
});
