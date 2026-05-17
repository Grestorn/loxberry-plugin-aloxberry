'use strict';

// Observed Alexa pairings tracker.
//
// The Lambda forwards each directive with two extra header fields:
//   x-aloxberry-pairing-id    — the DDB-side userId for the Alexa account
//   x-aloxberry-pairing-name  — the friendlyName the user chose at OAuth-link time
//
// We track each pairing the first time we see a directive from it, then bump
// its `lastSeen` and `count` on every subsequent directive. The CGI reads the
// resulting `pairings.json` to render an "Active pairings" panel.
//
// Caveats:
// — A pairing that linked but never sent a directive is invisible here.
//   In practice Alexa fires Discovery within seconds of a successful link,
//   so new pairings show up almost immediately.
// — These headers are NOT covered by the directive HMAC, so a compromised
//   bridge could spoof them. Display-only: the daemon never makes a trust
//   decision based on pairing identity. If two pairings share a name, they
//   still get distinct entries (id is the unique key).
// — On identity rotation ("kill all pairings"), the stored pairings are
//   stale (they point at DDB rows with the OLD bridgeUserId). The local-http
//   reset handler calls clear() to wipe them.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

class PairingsTracker {
  constructor({ dataDir, log }) {
    this.path = path.join(dataDir, 'pairings.json');
    this.tmpPath = `${this.path}.tmp`;
    this.log = log.child({ component: 'pairings' });
    this.pairings = this._loadSync();
    // Serialize disk writes so concurrent observe() calls don't interleave
    // their writes through rename().
    this.writeChain = Promise.resolve();
  }

  _loadSync() {
    try {
      const text = fs.readFileSync(this.path, 'utf8');
      const data = JSON.parse(text);
      if (data && typeof data === 'object') return data;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log?.warn?.({ err: err.message }, 'pairings.json unreadable — starting empty');
      }
    }
    return {};
  }

  async observe({ pairingId, pairingName, directiveNs, directiveName }) {
    if (!pairingId || typeof pairingId !== 'string') return;
    const now = new Date().toISOString();
    const existing = this.pairings[pairingId] || { firstSeen: now, count: 0 };
    this.pairings[pairingId] = {
      // Update name on every observe — friendlyName may have changed in the
      // DDB row since the last time we saw a directive (the OAuth handler
      // could in theory let users rename, eventually).
      name: pairingName || existing.name || '',
      firstSeen: existing.firstSeen,
      lastSeen: now,
      count: (existing.count || 0) + 1,
      lastDirective:
        directiveNs && directiveName ? `${directiveNs}.${directiveName}` : (existing.lastDirective || null),
    };
    await this._enqueueSave();
  }

  async clear() {
    this.pairings = {};
    await this._enqueueSave();
  }

  // Public read for the CGI / local-http /pairings endpoint.
  list() {
    return Object.entries(this.pairings).map(([id, data]) => ({ id, ...data }));
  }

  _enqueueSave() {
    // Serialize writes: each new save awaits the previous one. Keeps the
    // .tmp → rename atomicity intact under concurrent observe() calls.
    this.writeChain = this.writeChain.then(
      () => this._writeOnce(),
      () => this._writeOnce(),
    );
    return this.writeChain;
  }

  async _writeOnce() {
    try {
      const body = JSON.stringify(this.pairings, null, 2) + '\n';
      await fsp.writeFile(this.tmpPath, body, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(this.tmpPath, this.path);
    } catch (err) {
      this.log?.error?.({ err: err.message }, 'failed to persist pairings.json');
    }
  }
}

module.exports = { PairingsTracker };
