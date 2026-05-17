'use strict';

// Stable per-install UUID used as the Loxone client identifier in getjwt /
// authwithtoken / refreshjwt requests. Loxone tracks tokens by this UUID;
// generating a fresh one on every restart would accumulate stale token slots
// on the Miniserver (which has finite storage).
//
// Format: 8-4-4-16 hex chars (Loxone's non-RFC variant). Generated on first
// daemon start and persisted to data/daemon-uuid.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'daemon-uuid';
// Loxone's UUID shape: <8>-<4>-<4>-<16> hex digits. 32 hex chars total.
const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/;

function loadOrCreate(dataDir) {
  const filePath = path.join(dataDir, FILE_NAME);
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (RE.test(existing)) return existing;
    // File present but malformed — overwrite cleanly with a fresh value.
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const fresh = generate();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic write so a concurrent reader never sees a half-written file.
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, fresh + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return fresh;
}

function generate() {
  const b = crypto.randomBytes(16);
  // d1 (4 LE bytes) — but for opacity it doesn't matter, just emit hex.
  const hex = b.toString('hex');
  // Slice into 8-4-4-16.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16)}`;
}

module.exports = { loadOrCreate, generate };
