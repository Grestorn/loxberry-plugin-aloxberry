'use strict';

// On-disk cache of the Miniserver JWT.
//
// File: <DATA_DIR>/miniserver-token.json, chmod 600.
// Contents:
//   {
//     "version":     1,
//     "snr":         "50:4F:94:A1:E3:C8",     // Miniserver hardware serial
//     "username":    "loxberry",              // user the token was issued for
//     "token":       "<JWT string>",
//     "key":         "<hex HMAC key for refresh>",
//     "validUntil":  <seconds since Loxone epoch 2009-01-01 UTC>,
//     "savedAt":     "ISO8601 wall-clock for forensics"
//   }
//
// Invalidation conditions:
//   - file missing                          → no cache
//   - SNR mismatch (different Miniserver)   → discard, treat as no cache
//   - username mismatch (account switched)  → discard
//   - validUntil already past                → discard
//
// The daemon should THEN fall back to full getjwt + cache the new token.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'miniserver-token.json';
const SCHEMA_VERSION = 1;

// Loxone tokens count seconds since 2009-01-01 00:00:00 UTC.
const LOXONE_EPOCH_MS = Date.UTC(2009, 0, 1, 0, 0, 0);
const SECONDS_PER_DAY = 86_400;

class MiniserverTokenStore {
  constructor({ dataDir, log }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, FILE_NAME);
    this.log = log.child({ component: 'token-store' });
  }

  // Returns the cached token if it exists, parses cleanly, and matches the
  // expected SNR + username. Returns null otherwise (and logs the reason).
  async load({ expectedSnr, expectedUsername } = {}) {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      this.log.warn({ err: err.message }, 'token file read failed');
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log.warn({ err: err.message }, 'token file is malformed JSON — discarding');
      await this._safeUnlink();
      return null;
    }
    if (parsed.version !== SCHEMA_VERSION) {
      this.log.warn({ version: parsed.version }, 'token file schema version mismatch — discarding');
      await this._safeUnlink();
      return null;
    }

    if (expectedSnr && parsed.snr && parsed.snr !== expectedSnr) {
      this.log.info({ cached: parsed.snr, current: expectedSnr }, 'cached token is for a different Miniserver — ignoring');
      return null;
    }
    if (expectedUsername && parsed.username && parsed.username !== expectedUsername) {
      this.log.info({ cached: parsed.username, current: expectedUsername }, 'cached token is for a different user — ignoring');
      return null;
    }

    if (this.isExpired(parsed)) {
      this.log.info({ validUntilIso: this.validUntilIso(parsed) }, 'cached token already expired — ignoring');
      return null;
    }

    return parsed;
  }

  async save({ snr, username, token, key, validUntil }) {
    const payload = {
      version: SCHEMA_VERSION,
      snr,
      username,
      token,
      key,
      validUntil,
      savedAt: new Date().toISOString(),
    };
    const body = JSON.stringify(payload, null, 2) + '\n';
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    // chmod 600 — token is roughly password-equivalent for the daemon's lifetime.
    await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  async clear() {
    await this._safeUnlink();
  }

  isExpired(stored) {
    const validUntilMs = LOXONE_EPOCH_MS + stored.validUntil * 1000;
    return validUntilMs <= Date.now();
  }

  // True when the token's remaining lifetime is below the threshold.
  expiresWithinSeconds(stored, seconds) {
    const validUntilMs = LOXONE_EPOCH_MS + stored.validUntil * 1000;
    return (validUntilMs - Date.now()) <= seconds * 1000;
  }

  validUntilIso(stored) {
    if (typeof stored.validUntil !== 'number') return null;
    return new Date(LOXONE_EPOCH_MS + stored.validUntil * 1000).toISOString();
  }

  async _safeUnlink() {
    try { await fs.unlink(this.filePath); } catch { /* ignore */ }
  }
}

// Synchronous helper for tests / one-shot scripts.
function readTokenSync(dataDir) {
  const filePath = path.join(dataDir, FILE_NAME);
  try {
    return JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  MiniserverTokenStore,
  readTokenSync,
  LOXONE_EPOCH_MS,
  SECONDS_PER_DAY,
};
