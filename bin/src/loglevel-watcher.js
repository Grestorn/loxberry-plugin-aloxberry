'use strict';

// Live log-level watcher.
//
// The LoxBerry per-plugin log level is changed in LoxBerry CORE's Log
// Manager UI. That fires no plugin hook — our CGI never runs when the user
// moves that slider — so there is nothing to subscribe to. Something has to
// OBSERVE. This is that observer: every `intervalMs` it spawns the read-only
// Perl accessor (lox-loglevel.pl) and, when the value differs from the
// logger's current threshold, applies it live via log.setLevel(). No
// restart, no new log session.
//
// Design choices, all matching existing daemon idioms:
//   - The logger itself is the single source of truth for "current level"
//     (log.getLevel()); the watcher keeps no separate bookkeeping, so the
//     /log-level endpoint and this poller converge automatically — both
//     just read/write the shared level holder through `log`.
//   - execFile('perl', [script], {timeout}) — same spawn shape as
//     miniserver-config.js / loxone-command.js.
//   - The interval is unref'd (cf. index.js stateFlushTimer) so it can
//     never by itself keep a dead daemon alive.
//   - A failed read (perl missing, LoxBerry unreadable) is logged at DEBUG,
//     not WARN: level changes are rare and a transient failure must not
//     flood the log every interval. The current level is kept (fail-safe).

const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'lox-loglevel.pl');
const DEFAULT_EXECUTABLE = 'perl';
const DEFAULT_INTERVAL_MS = 45_000;
const SPAWN_TIMEOUT_MS = 10_000;

class LogLevelWatcher {
  constructor({ log, intervalMs = DEFAULT_INTERVAL_MS, executable = DEFAULT_EXECUTABLE, scriptPath = SCRIPT_PATH }) {
    // NB: keep a reference to the ROOT-ish logger (or any child of it) — all
    // share the same level holder, so setLevel here re-thresholds everything.
    this.log = log.child({ component: 'loglevel-watcher' });
    this.intervalMs = intervalMs;
    this.executable = executable;
    this.scriptPath = scriptPath;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    // Don't run an immediate check at boot: control.sh already seeded the
    // correct level from LOG_LEVEL via log-session-create.pl. First poll is
    // one interval out.
    this.timer = setInterval(() => {
      this.checkNow().catch((err) =>
        this.log.debug({ err: err && err.message }, 'loglevel poll iteration threw'));
    }, this.intervalMs);
    this.timer.unref();
    this.log.info({ intervalMs: this.intervalMs }, 'loglevel watcher started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Read the LoxBerry level once and apply it if it changed. Returns
  // { changed, from, to } on a successful read, or { error } on a failed
  // read (so the /log-level "re-read now" path can report it). Never throws
  // for an expected failure (spawn/exit/parse) — only truly unexpected
  // bugs propagate.
  async checkNow() {
    let fetched;
    try {
      fetched = await this._readLevel();
    } catch (err) {
      this.log.debug({ err: err.message }, 'loglevel re-read failed — keeping current level');
      return { error: err.message };
    }

    const current = this.log.getLevel();
    if (fetched === current) {
      return { changed: false, from: current, to: current };
    }
    const applied = this.log.setLevel(fetched);
    // applied===null is unreachable (lox-loglevel.pl already constrained
    // 0-7), but guard anyway rather than silently desync.
    if (applied === null) {
      this.log.debug({ fetched }, 'fetched level rejected by setLevel — keeping current');
      return { changed: false, from: current, to: current };
    }
    // This line is emitted at the NEW threshold. INFO (6) is visible at
    // levels >= 6; if the user lowered the level below info they won't see
    // it, which is fine — they asked for less. A drop FROM a verbose level
    // is still visible because the message about dropping is itself <= old.
    this.log.info({ from: current, to: applied }, 'log level changed — applied without restart');
    return { changed: true, from: current, to: applied };
  }

  _readLevel() {
    return new Promise((resolve, reject) => {
      execFile(
        this.executable,
        [this.scriptPath],
        { timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGTERM' },
        (err, stdoutBuf, stderrBuf) => {
          const stdout = (stdoutBuf || '').toString().trim();
          const stderr = (stderrBuf || '').toString().trim();
          if (err) {
            if (err.killed) return reject(new Error(`lox-loglevel.pl timed out after ${SPAWN_TIMEOUT_MS} ms`));
            if (typeof err.code === 'string') {
              return reject(new Error(`failed to spawn ${this.executable}: ${err.code}`));
            }
            return reject(new Error(`lox-loglevel.pl exited ${err.code}: ${stderr || '(no stderr)'}`));
          }
          const n = parseInt(stdout, 10);
          if (!Number.isInteger(n) || n < 0 || n > 7) {
            return reject(new Error(`lox-loglevel.pl produced non-level output: ${JSON.stringify(stdout)}`));
          }
          resolve(n);
        },
      );
    });
  }
}

module.exports = { LogLevelWatcher };
