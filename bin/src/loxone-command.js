'use strict';

// Outbound Miniserver commands — spawned-helper edition.
//
// Each .send() call invokes the Perl helper (`lox-send.pl`) which in turn
// uses `LoxBerry::IO::mshttp_send` to deliver a value to a Loxone Virtual
// Input. Token caching lives in `LoxBerry::IO`; we re-pay only process
// startup (~10-30 ms on a Pi), which is invisible at Alexa's traffic rate.
//
// Why a spawned helper instead of reimplementing the Miniserver client in
// Node: see plan/plugin-plan.md → "Loxone access from the daemon (revised
// 2026-05-12)". Short version: `LoxBerry::IO` is community-maintained and
// handles token rotation across firmware quirks; we'd be re-paying that
// maintenance burden in Node otherwise.
//
// Result schema (consumer-facing contract):
//   {
//     ok:        true | false,
//     exitCode:  number | null,           // child's exit code, null if spawn failed
//     category:  'success' | 'exit_nonzero' | 'timeout' | 'spawn_failed',
//     stdout:    string,                  // trimmed
//     stderr:    string,                  // trimmed; LoxBerry::IO diagnostics live here
//     durationMs: number,
//     spawnError: string | null,          // e.g. 'ENOENT' when perl missing
//   }
//
// Exit-code semantics from the helper (must stay in sync with lox-send.pl):
//   0 → success (stdout: "ok" or "ok value=<echo>"; the value field is the
//       Miniserver's echo of what it applied — useful to spot silent no-ops)
//   1 → Miniserver-side failure (stdout: "fail: ...")
//   2 → usage error / caller bug — should never happen at runtime

const { execFile } = require('node:child_process');
const path = require('node:path');

const SEND_SCRIPT_PATH    = path.join(__dirname, '..', 'lox-send.pl');
const CONTROL_SCRIPT_PATH = path.join(__dirname, '..', 'lox-control.pl');
const DEFAULT_EXECUTABLE = 'perl';
const DEFAULT_TIMEOUT_MS = 5000;

class LoxoneCommandClient {
  constructor({
    scriptPath = SEND_SCRIPT_PATH,           // kept for backwards-compat tests
    controlScriptPath = CONTROL_SCRIPT_PATH,
    executable = DEFAULT_EXECUTABLE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log,
  }) {
    this.sendScriptPath = scriptPath;
    this.controlScriptPath = controlScriptPath;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.log = log.child({ component: 'loxone-command' });
  }

  // Send a value to a Loxone Virtual Input by NAME.
  // Routes through lox-send.pl → LoxBerry::IO::mshttp_send.
  // Used by the legacy "Plugin Test" endpoint and any future name-based VIs.
  send({ msNo, name, value }) {
    return this._spawn(
      this.sendScriptPath,
      [String(msNo), String(name), String(value)],
      { msNo, target: name, kind: 'vi' },
    );
  }

  // Send a command to a Loxone control by UUID.
  // Routes through lox-control.pl → LoxBerry::IO::mshttp_call('jdev/sps/io/<uuid>/<cmd>').
  // Used by every picker-managed device (lights, switches, etc.).
  sendByUuid({ msNo, uuid, command }) {
    return this._spawn(
      this.controlScriptPath,
      [String(msNo), String(uuid), String(command)],
      { msNo, target: uuid, kind: 'uuid' },
    );
  }

  // Shared spawner. Always resolves (never rejects) — callers branch on
  // result.ok / result.category.
  _spawn(scriptPath, scriptArgs, ctx) {
    const args = [scriptPath, ...scriptArgs];
    const startedAt = Date.now();

    return new Promise((resolve) => {
      execFile(
        this.executable,
        args,
        { timeout: this.timeoutMs, killSignal: 'SIGTERM' },
        (err, stdoutBuf, stderrBuf) => {
          const durationMs = Date.now() - startedAt;
          const stdout = (stdoutBuf || '').toString().trim();
          const stderr = (stderrBuf || '').toString().trim();

          // Happy path.
          if (!err) {
            this._maybeLogHelperStderr({ ctx, stderr, durationMs, ok: true });
            return resolve({
              ok: true,
              exitCode: 0,
              category: 'success',
              stdout,
              stderr,
              durationMs,
              spawnError: null,
            });
          }

          // Three failure flavors; node's execFile encodes them in err itself.
          //
          //   err.killed === true          → we sent SIGTERM (timeout)
          //   typeof err.code === 'string' → spawn-time failure (e.g. ENOENT)
          //   typeof err.code === 'number' → child exited non-zero
          let category;
          let exitCode = null;
          let spawnError = null;
          if (err.killed) {
            category = 'timeout';
          } else if (typeof err.code === 'string') {
            category = 'spawn_failed';
            spawnError = err.code;
          } else if (typeof err.code === 'number') {
            category = 'exit_nonzero';
            exitCode = err.code;
          } else {
            // Defensive — shouldn't happen.
            category = 'spawn_failed';
            spawnError = err.message || 'unknown_spawn_error';
          }

          this._maybeLogHelperStderr({
            ctx, stderr, durationMs, ok: false, category, exitCode, spawnError,
          });

          resolve({
            ok: false,
            exitCode,
            category,
            stdout,
            stderr,
            durationMs,
            spawnError,
          });
        },
      );
    });
  }

  // Helper-side stderr matters for ops:
  //   - On failure: LoxBerry::IO prints things like "Miniserver N not found"
  //     or "Code=404". Surfacing it saves an SSH round trip.
  //   - On success: usually empty; log at debug for forensics if present.
  _maybeLogHelperStderr({ ctx, stderr, durationMs, ok, category, exitCode, spawnError }) {
    if (!stderr) return;
    const level = ok ? 'debug' : 'warn';
    this.log[level](
      { stderr, ...ctx, durationMs, category, exitCode, spawnError },
      ok
        ? 'helper produced stderr on success path'
        : 'helper produced stderr on failure path',
    );
  }
}

module.exports = { LoxoneCommandClient };
