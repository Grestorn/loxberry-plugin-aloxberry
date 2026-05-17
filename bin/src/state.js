'use strict';

// Daemon state — read by the Perl CGI to render the config page's
// connection-status section. Written atomically (write tmp → rename) so
// the CGI never sees a half-written file even mid-flush.
//
// This is one half of the plugin's IPC contract:
//   - state.json     : daemon writes, CGI reads        (this module)
//   - config.json    : CGI writes, daemon watches      (step 2+)
//   - commands/*.json: CGI drops, daemon processes     (later)
//
// Schema is small and CGI-facing. Add fields as the daemon learns new
// things; never rename existing ones without bumping the version.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const STATE_VERSION = 1;

class StateWriter {
  constructor({ dataDir, log }) {
    this.path = path.join(dataDir, 'state.json');
    this.tmpPath = `${this.path}.tmp`;
    this.log = log;
    this.current = {
      version: STATE_VERSION,
      status: 'starting',
      startedAt: new Date().toISOString(),
      bridge: { connected: false, lastError: null, lastConnectedAt: null },
      miniserver: { connected: false, lastError: null, lastEventAt: null },
      lastDirectiveAt: null,
    };
    // Serialize writes through a promise chain. Without this, two updates
    // running concurrently can interleave their writeFile(.tmp) → rename
    // calls: the first rename succeeds and removes .tmp, then the second
    // rename ENOENTs because there's no .tmp to move. Especially visible
    // during shutdown when bridge.stop(), session.stop() and
    // shutdown()'s own state.update all race.
    this.writeChain = Promise.resolve();
  }

  // Ensure the data dir exists. Synchronous because we call this once
  // at boot, before the event loop starts handling traffic.
  ensureDirSync() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
  }

  // Persist the current state. Internal — always called via the chain.
  async _writeNow() {
    const body = JSON.stringify(this.current, null, 2) + '\n';
    await fsp.writeFile(this.tmpPath, body, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(this.tmpPath, this.path);
  }

  // Shallow-merge a patch into the current state and persist. Concurrent
  // calls are serialized — each one awaits the previous write to finish
  // before laying down its own .tmp + rename.
  async update(patch) {
    this.current = mergeShallow(this.current, patch);
    // Capture the current chain head; the next caller awaits us in turn.
    const prev = this.writeChain;
    this.writeChain = prev.then(() => this._writeNow().catch((err) => {
      this.log.error({ err: errSerialize(err) }, 'failed to persist state.json');
    }));
    return this.writeChain;
  }

  snapshot() {
    return structuredClone(this.current);
  }
}

function mergeShallow(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function errSerialize(err) {
  if (!(err instanceof Error)) return err;
  return { name: err.name, message: err.message, code: err.code };
}

module.exports = { StateWriter, STATE_VERSION };
