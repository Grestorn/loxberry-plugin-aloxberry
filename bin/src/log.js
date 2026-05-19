'use strict';

/*
 * Aloxberry daemon logger.
 *
 * Pino-compatible call surface (`log.info({...}, 'msg')` + `log.child({...})`)
 * with plain-text output and LoxBerry's native log-level taxonomy. The 117
 * existing call sites do not need to change; only the construction in
 * bin/src/index.js does (a one-line swap from `pino(...)` to
 * `createLogger(...)`).
 *
 * Why a custom file vs. an off-the-shelf library:
 *   - pino's value is structured JSON for observability backends. We have
 *     no such backend — the only consumer is a human reading a text file
 *     in LoxBerry's log viewer. JSON-per-line is wasted there.
 *   - consola/winston/loglevel all ship their own level taxonomies. None
 *     match LoxBerry's `alert/critical/error/warning/ok/info/debug`. Any
 *     library choice puts a mapping table somewhere; this file is the
 *     mapping table, plus the formatter, plus the runtime — all in one
 *     place you can read in under a minute.
 *
 * Output format (one line per event; multi-line/long values lifted to
 * indented continuation lines):
 *
 *   2026-05-14T10:31:42.123Z [INFO ] bridge connected bridgeUrl="https://..."
 *   2026-05-14T10:31:42.456Z [CRIT ] fatal during startup err.name="TypeError" err.message="foo"
 *     err.stack: Error: TypeError: foo
 *       at Foo (file.js:1:1)
 *       at Bar (file.js:2:2)
 *
 * Levels (LoxBerry's 1-7 ordering — bigger = more verbose):
 *
 *   1  alert     -> [CRIT ]   log.fatal()
 *   2  critical  -> [CRIT ]   log.fatal()
 *   3  error     -> [ERROR]   log.error()
 *   4  warning   -> [WARN ]   log.warn()
 *   5  ok        -> [OK   ]   log.ok()        (no current call sites; reserved)
 *   6  info      -> [INFO ]   log.info()
 *   7  debug     -> [DEBUG]   log.debug() / log.trace()
 *
 * Filtering is "verbosity-style": a message is emitted iff its level is
 * <= the configured threshold. So threshold=4 (warning) suppresses ok,
 * info, debug.
 *
 * Configured via `createLogger({ level })`. Accepts:
 *   - LoxBerry numeric:  1..7  (and 0 for "silent" — even fatals dropped)
 *   - LoxBerry name:     'alert', 'critical', 'warning', 'ok', 'info', 'debug'
 *   - pino name:         'fatal', 'error', 'warn', 'info', 'debug', 'trace'
 * Default: 6 (info). Unknown values also default to 6 with a one-time
 * warning written to stderr — fail-safe rather than fail-quiet.
 */

const LEVEL_FROM_STRING = {
  // LoxBerry names (preferred — single source of truth)
  alert:    1,
  critical: 2,
  warning:  4,
  ok:       5,
  // pino names (back-compat for dev / standalone runs)
  fatal:    2,
  error:    3,
  warn:     4,
  trace:    7,
  // Shared
  info:     6,
  debug:    7,
};

const TAG_FROM_LEVEL = {
  1: 'CRIT ',
  2: 'CRIT ',
  3: 'ERROR',
  4: 'WARN ',
  5: 'OK   ',
  6: 'INFO ',
  7: 'DEBUG',
};

const DEFAULT_LEVEL = 6;

// Pure parse: LoxBerry numeric (0-7), LoxBerry/pino name, or numeric string
// → integer 0-7. Returns null for anything it can't make sense of — NO
// side effects, NO default. Used by callers that must distinguish "valid
// new level" from "garbage" (the live /log-level endpoint rejects garbage
// with 400; the poller keeps the current level on garbage).
function coerceLevel(raw) {
  if (raw === 0) return 0; // silent
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 7) {
    return raw;
  }
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVEL_FROM_STRING, key)) {
      return LEVEL_FROM_STRING[key];
    }
    // Numeric-as-string also fine (the daemon receives LOG_LEVEL via env,
    // which is always a string).
    const n = parseInt(key, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 7) return n;
  }
  return null;
}

// Fail-safe wrapper for the boot path (LOG_LEVEL env): unknown → info (6)
// with a one-time stderr breadcrumb. The daemon must always come up logging.
function resolveLevel(raw) {
  const lvl = coerceLevel(raw);
  if (lvl !== null) return lvl;
  process.stderr.write(
    `[log] unknown level ${JSON.stringify(raw)} — defaulting to info (6)\n`
  );
  return DEFAULT_LEVEL;
}

// Long-value threshold: strings longer than this OR containing a newline
// are lifted to a continuation line instead of inlined as key="...".
// 80 = comfortably below typical terminal width once you add the
// timestamp + tag + message prefix.
const INLINE_MAX = 80;

function isInlineable(v) {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return true;
  if (t === 'string') return !v.includes('\n') && v.length <= INLINE_MAX;
  return false;
}

function formatInlineValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

// Flatten one level deep so `{err: {name, message, stack}}` becomes
// `err.name`, `err.message`, `err.stack`. Two reasons:
//   1. Keeps each field greppable as its own column on the inline line.
//   2. Lets us lift the (multi-line) `err.stack` to a continuation line
//      while keeping `err.name` + `err.message` inline.
// Deeper nesting falls through unflattened; in practice the daemon never
// passes more than one level.
function flattenOnce(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const k of Object.keys(payload)) {
    const v = payload[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      for (const inner of Object.keys(v)) {
        out[`${k}.${inner}`] = v[inner];
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Build the inline `key=value` tail and any continuation lines.
function formatContext(bindings, payload) {
  const merged = { ...bindings, ...flattenOnce(payload) };
  const keys = Object.keys(merged);
  if (keys.length === 0) return { inline: '', block: '' };

  const inlineParts = [];
  const blockLines = [];
  for (const k of keys) {
    const v = merged[k];
    if (isInlineable(v)) {
      inlineParts.push(`${k}=${formatInlineValue(v)}`);
    } else {
      // Continuation line. Strings: print as-is (preserves stack newlines).
      // Other types: JSON-stringify with indent so nested structure is readable.
      let rendered;
      if (typeof v === 'string') {
        rendered = v;
      } else {
        try {
          rendered = JSON.stringify(v, null, 2);
        } catch (_e) {
          rendered = '[unserializable]';
        }
      }
      // Continuation line shape:
      //   "  err.stack:\n    <line 1>\n    <line 2>\n..."
      // Every line of the value is uniformly indented 4 spaces; the key
      // label sits at 2 spaces. Indent levels chosen so that Node's stack
      // traces (which already start with "    at ...") remain readable
      // without ambiguous nesting.
      const indented = rendered.split('\n').map((l) => '    ' + l).join('\n');
      blockLines.push(`  ${k}:\n${indented}`);
    }
  }
  return {
    inline: inlineParts.length ? ' ' + inlineParts.join(' ') : '',
    block:  blockLines.length  ? '\n' + blockLines.join('\n') : '',
  };
}

class Logger {
  // `holder` is a shared { value } cell — NOT a copied scalar. The root
  // logger and every .child() created from it point at the SAME holder, so
  // setLevel() on any one instance re-thresholds all 117 call sites at once,
  // with no restart. (Previously _level was copied by value into each child,
  // which is why a level change used to require a daemon restart.)
  constructor(holder, bindings) {
    this._holder = holder;
    this._bindings = bindings || {};
  }

  // pino-compatible: returns a new logger sharing the threshold holder, with
  // bindings merged. Children can themselves call .child().
  child(bindings) {
    return new Logger(this._holder, { ...this._bindings, ...(bindings || {}) });
  }

  // Live re-threshold. Accepts the same forms as createLogger({level}).
  // Returns the resolved integer level on success, or null on garbage
  // (in which case the current level is left untouched — fail-safe). The
  // caller decides how to treat null (poller: keep + debug; endpoint: 400).
  setLevel(raw) {
    const lvl = coerceLevel(raw);
    if (lvl === null) return null;
    this._holder.value = lvl;
    return lvl;
  }

  getLevel() {
    return this._holder.value;
  }

  // Internal: filter first (lazy — no formatting when below threshold),
  // then format and write a single contiguous block to stdout.
  _emit(eventLevel, arg1, arg2) {
    // Level filter: LoxBerry semantics (emit iff event-level <= threshold).
    // Read through the shared holder so a live setLevel() takes effect on
    // the very next event, including for already-created child loggers.
    if (eventLevel > this._holder.value) return;

    // Tolerate the same call signatures pino does:
    //   log.info('msg')
    //   log.info({k:v}, 'msg')
    //   log.info({k:v})
    let payload = null;
    let msg = '';
    if (typeof arg1 === 'string') {
      msg = arg1;
    } else {
      payload = arg1;
      msg = (typeof arg2 === 'string') ? arg2 : '';
    }

    const ts  = new Date().toISOString();
    const tag = TAG_FROM_LEVEL[eventLevel] || 'INFO ';
    const { inline, block } = formatContext(this._bindings, payload || {});

    // Single write — node's stdout is line-buffered when going to a TTY
    // and block-buffered to a file, but Node still flushes promptly.
    // Concatenating into one write avoids torn output if two log events
    // race (each event is one atomic write).
    process.stdout.write(`${ts} [${tag}] ${msg}${inline}${block}\n`);
  }

  fatal(arg1, arg2) { this._emit(2, arg1, arg2); }
  error(arg1, arg2) { this._emit(3, arg1, arg2); }
  warn (arg1, arg2) { this._emit(4, arg1, arg2); }
  ok   (arg1, arg2) { this._emit(5, arg1, arg2); }
  info (arg1, arg2) { this._emit(6, arg1, arg2); }
  debug(arg1, arg2) { this._emit(7, arg1, arg2); }
  trace(arg1, arg2) { this._emit(7, arg1, arg2); } // folded to debug
}

function createLogger(opts) {
  const o = opts || {};
  // One holder per logger tree; shared by reference with all children.
  return new Logger({ value: resolveLevel(o.level) }, {});
}

module.exports = { createLogger, coerceLevel };
