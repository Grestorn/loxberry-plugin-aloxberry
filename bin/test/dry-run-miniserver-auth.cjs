#!/usr/bin/env node
// DRY-RUN diagnostic for the getjwt flow. Performs:
//   - keyexchange (safe, public)
//   - getkey2     (safe, public — username is sent but no password)
//   - local pwHash + hash computation (zero network)
// then PRINTS the full URL it WOULD send, but does NOT actually send getjwt.
//
// The user can eyeball the intermediate values for anomalies before we burn
// a lockout-counter increment on the real attempt.
'use strict';

const crypto = require('node:crypto');
const { loadWithCredentials } = require('../src/miniserver-config');
const { fetchPublicKey } = require('../src/miniserver-probe');
const { MiniserverWsClient } = require('../src/miniserver-ws');
const c = require('../src/miniserver-crypto');

const log = {
  debug() {}, info() {}, warn() {}, error(o, m) { console.log('ERROR', m, o); },
  child() { return this; },
};

const DAEMON_UUID = '6c6f7868-6f6d-6500-616c6578612d6873';
const CLIENT_INFO = encodeURIComponent('aloxberry-daemon');
const PERMISSION_APP = 4;

const charClasses = (s) => {
  if (typeof s !== 'string') return '(not a string)';
  let cc = '';
  if (/[a-z]/.test(s)) cc += 'a';
  if (/[A-Z]/.test(s)) cc += 'A';
  if (/[0-9]/.test(s)) cc += '0';
  if (/[^a-zA-Z0-9]/.test(s)) cc += 'S';
  return cc || '(empty)';
};

(async () => {
  console.log('\n=== 1. read credentials ===');
  const [ms] = await loadWithCredentials();
  const { username, password } = ms.getCredentialsForAuth();
  console.log(`  username = "${username}"   length=${username.length}`);
  console.log(`  password length = ${password.length}   classes = ${charClasses(password)}`);
  console.log(`  password starts with "${password[0]}" ends with "${password[password.length-1]}" (sanity, never the body)`);
  // Trim test — would a stray newline/space mess this up?
  console.log(`  password === password.trim()? ${password === password.trim()}`);

  console.log('\n=== 2. fetch RSA public key ===');
  const pem = await fetchPublicKey(ms);
  const publicKey = crypto.createPublicKey(pem);
  console.log(`  pubkey type = ${publicKey.asymmetricKeyType}, modulus = ${publicKey.asymmetricKeyDetails?.modulusLength}`);

  console.log('\n=== 3. open WS + keyexchange (single round-trip, no auth involved) ===');
  const client = new MiniserverWsClient({ msConfig: ms, publicKey, log });
  await client.start();
  console.log('  ✓ keyexchange successful, AES session established');

  console.log('\n=== 4. encrypted getkey2 (no password leaves the machine) ===');
  const k2 = await client.sendEncrypted(`jdev/sys/getkey2/${username}`);
  console.log(`  getkey2 Code = ${k2?.LL?.Code}`);
  const { key, salt, hashAlg } = k2?.LL?.value || {};
  console.log(`  hashAlg = "${hashAlg}"`);
  console.log(`  salt: length=${salt?.length}  startsWith="${salt?.slice(0, 8)}"  endsWith="${salt?.slice(-8)}"  classes=${charClasses(salt || '')}`);
  console.log(`  key:  length=${key?.length}   startsWith="${key?.slice(0, 8)}"   endsWith="${key?.slice(-8)}"   classes=${charClasses(key || '')}`);

  // Sanity: salt/key look like hex?
  console.log(`  salt all-hex? ${/^[0-9a-fA-F]+$/.test(salt || '')}`);
  console.log(`  key  all-hex? ${/^[0-9a-fA-F]+$/.test(key || '')}`);

  console.log('\n=== 5. compute pwHash + hash LOCALLY (no network) ===');
  const pwHash = c.passwordHash(password, salt, hashAlg);
  console.log(`  pwHash (uppercase ${hashAlg}("password:salt")): ${pwHash}`);
  console.log(`  pwHash length = ${pwHash.length}   expected = ${hashAlg === 'SHA256' ? 64 : 40}`);

  const hash = c.userHmac(key, username, pwHash, hashAlg);
  console.log(`  hash (HMAC-${hashAlg}(key_bytes, "user:pwHash")): ${hash}`);
  console.log(`  hash length = ${hash.length}   expected = ${hashAlg === 'SHA256' ? 64 : 40}`);

  console.log('\n=== 6. what we WOULD send (dry run — NOT sending) ===');
  const innerCmd = `jdev/sys/getjwt/${hash}/${username}/${PERMISSION_APP}/${DAEMON_UUID}/${CLIENT_INFO}`;
  console.log(`  inner plaintext (pre-encryption):`);
  console.log(`    ${innerCmd}`);
  console.log(`  inner length = ${innerCmd.length}`);

  console.log('\n=== 7. shutdown without sending getjwt ===');
  await client.stop();
  await new Promise((r) => setTimeout(r, 200));
  console.log('  ✓ socket closed cleanly');
  console.log('\nDONE — no getjwt sent, no lockout-counter increment.');
})().catch((err) => {
  console.log(`\nfatal: ${err.message}`);
  process.exit(1);
});
