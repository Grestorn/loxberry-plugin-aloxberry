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

  // Remove the named entries from pairings.json. Used after Lambda confirms
  // the corresponding DDB rows were deleted ("Remove broken links" path).
  // Missing IDs are silently ignored — the daemon's view may already be a
  // step ahead of (or behind) Lambda's, which is fine because the next
  // welcome snapshot reconciles authoritatively.
  async removeMany(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    let removed = 0;
    for (const id of ids) {
      if (id && this.pairings[id]) {
        delete this.pairings[id];
        removed++;
      }
    }
    if (removed > 0) await this._enqueueSave();
    return removed;
  }

  // Flag a paired Alexa account as needing re-link (LWA refresh-token revoked,
  // signalled by Lambda via the bridge `notification` channel). Creates a
  // placeholder entry if the daemon has never observed a directive from this
  // pairing — that case is unusual (Alexa fires Discovery seconds after a
  // successful link) but possible, e.g. if the daemon was offline at the time.
  async markRevoked(alexaUserId, revokedAt) {
    if (!alexaUserId || typeof alexaUserId !== 'string') return;
    const now = new Date().toISOString();
    const existing = this.pairings[alexaUserId] || { firstSeen: now, count: 0 };
    this.pairings[alexaUserId] = {
      ...existing,
      revoked:    true,
      revokedAt:  revokedAt || now,
    };
    await this._enqueueSave();
  }

  // Apply a fresh `health-snapshot` from Lambda (delivered after the WSS
  // welcome handshake). The snapshot is authoritative: it lists every
  // currently-revoked Alexa account for this bridgeUserId. We clear any
  // `revoked` flag on entries NOT in the list (handles the case where a
  // user re-linked while the daemon was disconnected — Lambda already
  // cleared the DDB flag on AcceptGrant) and set it on entries that ARE
  // in the list.
  async applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const revoked = Array.isArray(snapshot.revoked) ? snapshot.revoked : [];
    const revokedById = new Map();
    for (const r of revoked) {
      if (r && typeof r.alexaUserId === 'string') {
        revokedById.set(r.alexaUserId, r.revokedAt || null);
      }
    }
    // Update known pairings.
    for (const [id, row] of Object.entries(this.pairings)) {
      if (revokedById.has(id)) {
        row.revoked   = true;
        row.revokedAt = revokedById.get(id) || row.revokedAt || new Date().toISOString();
      } else if (row.revoked) {
        // User re-linked while we weren't watching — clear the stale flag.
        delete row.revoked;
        delete row.revokedAt;
      }
    }
    // Create placeholders for revoked pairings we've never seen a directive from.
    const now = new Date().toISOString();
    for (const [id, revokedAt] of revokedById) {
      if (!this.pairings[id]) {
        this.pairings[id] = {
          firstSeen: now,
          count:     0,
          revoked:   true,
          revokedAt: revokedAt || now,
        };
      }
    }
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
