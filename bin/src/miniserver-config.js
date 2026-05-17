'use strict';

// Miniserver configuration loader.
//
// Spawns `lox-getconfig.pl` (a tiny Perl wrapper around
// LoxBerry::System::get_miniservers) and exposes the result as a typed JS
// object. Two modes:
//
//   load()                — public info only (host, ports, scheme, ...).
//                           Safe to log; used at daemon boot for the
//                           status page in state.json.
//
//   loadWithCredentials() — same plus { username, password }. Daemon-only,
//                           never logged. The returned MiniserverConfig
//                           overrides toJSON / inspect so accidentally
//                           passing it to console.log / the logger doesn't leak.
//
// Spawning a Perl helper instead of parsing general.cfg ourselves keeps
// us insulated from LoxBerry config-file format changes — the LoxBerry::*
// API is the contract that's likely to stay stable across versions.

const { execFile } = require('node:child_process');
const path = require('node:path');
const util = require('node:util');

const DEFAULT_SCRIPT_PATH = path.join(__dirname, '..', 'lox-getconfig.pl');
const DEFAULT_EXECUTABLE = 'perl';
const DEFAULT_TIMEOUT_MS = 5000;

// Symbol-keyed credential storage. Symbols aren't enumerated by JSON.stringify
// or the logger's inline serializer, so a stray log of a MiniserverConfig
// won't surface the password. The toJSON / [util.inspect.custom] overrides
// also strip them for direct console.log calls.
const kCredentials = Symbol('credentials');

class MiniserverConfig {
  constructor(raw) {
    this.msNo        = raw.msNo;
    this.name        = raw.name;
    this.host        = raw.host;
    this.portHttp    = raw.portHttp;
    this.portHttps   = raw.portHttps;
    this.preferHttps = raw.preferHttps;
    this.scheme      = raw.scheme;       // 'http' | 'https'
    this.useCloudDNS = raw.useCloudDNS;
    this.cloudUrl    = raw.cloudUrl;

    // If credentials are present, stash them behind a symbol.
    if (raw.username !== undefined || raw.password !== undefined) {
      this[kCredentials] = Object.freeze({
        username: raw.username || '',
        password: raw.password || '',
      });
    }
  }

  hasCredentials() {
    return this[kCredentials] !== undefined;
  }

  // Explicit, name-loud accessor so it's obvious in code reviews when
  // credentials are being read.
  getCredentialsForAuth() {
    if (!this[kCredentials]) {
      throw new Error('MiniserverConfig has no credentials (was load() used instead of loadWithCredentials()?)');
    }
    return this[kCredentials];
  }

  // The canonical HTTP(S) base URL — used for /jdev/* calls.
  httpsBase() {
    if (this.scheme === 'https' || this.preferHttps) {
      return `https://${this.host}:${this.portHttps}`;
    }
    return `http://${this.host}:${this.portHttp}`;
  }

  // The canonical WS(S) base URL — used to compose /ws/rfc6455.
  wsBase() {
    if (this.scheme === 'https' || this.preferHttps) {
      return `wss://${this.host}:${this.portHttps}`;
    }
    return `ws://${this.host}:${this.portHttp}`;
  }

  toJSON() {
    return {
      msNo: this.msNo,
      name: this.name,
      host: this.host,
      portHttp: this.portHttp,
      portHttps: this.portHttps,
      preferHttps: this.preferHttps,
      scheme: this.scheme,
      useCloudDNS: this.useCloudDNS,
      cloudUrl: this.cloudUrl,
      hasCredentials: this.hasCredentials(),
    };
  }

  [util.inspect.custom]() {
    return `MiniserverConfig(${JSON.stringify(this.toJSON())})`;
  }
}

async function spawnHelper({ scriptPath, executable, timeoutMs, withCredentials }) {
  const args = [scriptPath];
  if (withCredentials) args.push('--with-credentials');

  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { timeout: timeoutMs, killSignal: 'SIGTERM' },
      (err, stdoutBuf, stderrBuf) => {
        const stdout = (stdoutBuf || '').toString();
        const stderr = (stderrBuf || '').toString().trim();

        if (err) {
          if (err.killed) return reject(new Error(`lox-getconfig.pl timed out after ${timeoutMs} ms`));
          if (typeof err.code === 'string') {
            return reject(new Error(`failed to spawn ${executable}: ${err.code}`));
          }
          return reject(new Error(`lox-getconfig.pl exited ${err.code}: ${stderr || '(no stderr)'}`));
        }

        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch (parseErr) {
          return reject(new Error(`lox-getconfig.pl produced invalid JSON: ${parseErr.message}`));
        }
        if (!Array.isArray(parsed)) {
          return reject(new Error('lox-getconfig.pl output was not an array'));
        }
        resolve(parsed);
      },
    );
  });
}

async function load({
  scriptPath = DEFAULT_SCRIPT_PATH,
  executable = DEFAULT_EXECUTABLE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const raw = await spawnHelper({ scriptPath, executable, timeoutMs, withCredentials: false });
  return raw.map((r) => new MiniserverConfig(r));
}

async function loadWithCredentials({
  scriptPath = DEFAULT_SCRIPT_PATH,
  executable = DEFAULT_EXECUTABLE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const raw = await spawnHelper({ scriptPath, executable, timeoutMs, withCredentials: true });
  return raw.map((r) => new MiniserverConfig(r));
}

module.exports = { load, loadWithCredentials, MiniserverConfig };
