#!/usr/bin/env node
// Unit tests for bridge-hmac.js — verifies the daemon's HMAC contract matches
// the Lambda's signAloxberryRequest. We replicate the Lambda's signing locally
// so changes to the wire contract trip these tests immediately.
'use strict';

const crypto = require('node:crypto');
const { verifyDirective, VerifyError } = require('../src/bridge-hmac');

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

// Local mirror of the Lambda's signing logic. Importantly, this signs over the
// directive JSON only — same convention the alexa-handler uses.
function lambdaSign(directive, skillSecret, timestamp = Date.now()) {
  const body = JSON.stringify(directive);
  const sig = crypto.createHmac('sha256', skillSecret)
    .update(`${timestamp}\n${body}`, 'utf8')
    .digest('hex');
  return {
    'x-aloxberry-timestamp': String(timestamp),
    'x-aloxberry-signature': sig,
  };
}

(async () => {
  const skillSecret = crypto.randomBytes(32);
  const directive = {
    header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3', messageId: 'm1' },
    endpoint: { endpointId: 'alexa-pluginTest' },
    payload: {},
  };

  await test('valid signature verifies', async () => {
    const headers = lambdaSign(directive, skillSecret);
    const res = verifyDirective({ directive, headers, skillSecret });
    eq(res.ok, true, 'ok');
  });

  await test('mixed-case headers verify', async () => {
    const headers = lambdaSign(directive, skillSecret);
    const mixed = {
      'X-Aloxberry-Timestamp': headers['x-aloxberry-timestamp'],
      'X-Aloxberry-Signature': headers['x-aloxberry-signature'],
    };
    const res = verifyDirective({ directive, headers: mixed, skillSecret });
    eq(res.ok, true, 'ok');
  });

  await test('wrong secret → signature_mismatch', async () => {
    const headers = lambdaSign(directive, crypto.randomBytes(32));
    try {
      verifyDirective({ directive, headers, skillSecret });
      nope('did not throw');
    } catch (e) {
      check(e instanceof VerifyError, 'VerifyError');
      eq(e.reason, 'signature_mismatch', 'signature_mismatch');
    }
  });

  await test('tampered directive → signature_mismatch', async () => {
    const headers = lambdaSign(directive, skillSecret);
    const tampered = { ...directive, payload: { evil: true } };
    try {
      verifyDirective({ directive: tampered, headers, skillSecret });
      nope('did not throw');
    } catch (e) {
      eq(e.reason, 'signature_mismatch', 'signature_mismatch');
    }
  });

  await test('expired timestamp → expired', async () => {
    const oldTs = Date.now() - 10 * 60 * 1000; // 10 min ago, beyond ±5 min skew
    const headers = lambdaSign(directive, skillSecret, oldTs);
    try {
      verifyDirective({ directive, headers, skillSecret });
      nope('did not throw');
    } catch (e) {
      eq(e.reason, 'expired', 'expired');
    }
  });

  await test('missing header → missing_header', async () => {
    try {
      verifyDirective({ directive, headers: {}, skillSecret });
      nope('did not throw');
    } catch (e) { eq(e.reason, 'missing_header', 'missing_header'); }
  });

  await test('no secret → no_secret', async () => {
    const headers = lambdaSign(directive, skillSecret);
    try {
      verifyDirective({ directive, headers, skillSecret: Buffer.alloc(0) });
      nope('did not throw');
    } catch (e) { eq(e.reason, 'no_secret', 'no_secret'); }
  });

  await test('bad hex signature → bad_signature_hex or signature_mismatch', async () => {
    const headers = lambdaSign(directive, skillSecret);
    headers['x-aloxberry-signature'] = 'not-hex-zzzz';
    try {
      verifyDirective({ directive, headers, skillSecret });
      nope('did not throw');
    } catch (e) {
      // Buffer.from(..., 'hex') is lenient — silently truncates at first invalid
      // char. So 'not-hex-zzzz' becomes a 0-byte buffer, which fails length check.
      check(
        e.reason === 'signature_mismatch' || e.reason === 'bad_signature_hex',
        'bad_signature_hex or signature_mismatch',
        `got ${e.reason}`,
      );
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
