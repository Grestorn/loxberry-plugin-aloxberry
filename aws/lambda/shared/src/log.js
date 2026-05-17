'use strict';

// Lambda's structured-log mode (LogFormat: JSON in template.yaml) means that
// every console.log line is treated as a JSON record by CloudWatch Logs Insights.
// We emit one JSON object per log call so fields are queryable.
//
// Level filtering via LOG_LEVEL env var (default INFO):
//   DEBUG — everything, used during development / when investigating issues
//   INFO  — lifecycle events only (AcceptGrant, user registration, errors).
//           Per-request and per-event lines are silenced.
//   WARN  — only unexpected non-fatal conditions
//   ERROR — only failures
//
// Why aggressive default filtering matters: at scale (hundreds of users × 100+
// devices polling every minute) per-request INFO logging produces tens of GB
// of CloudWatch ingestion per day. INFO must stay rare-event-only so the
// operator's log read stays affordable at production scale; DEBUG re-enables
// the verbose trail when you actually need it.

const LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 });
const ENV_LEVEL = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const THRESHOLD = LEVELS[ENV_LEVEL] != null ? LEVELS[ENV_LEVEL] : LEVELS.INFO;

function emit(level, msg, fields) {
  if (LEVELS[level] < THRESHOLD) return;
  const record = { level, msg, ...(fields || {}) };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

const log = {
  debug: (msg, fields) => emit('DEBUG', msg, fields),
  info:  (msg, fields) => emit('INFO',  msg, fields),
  warn:  (msg, fields) => emit('WARN',  msg, fields),
  error: (msg, fields) => emit('ERROR', msg, fields),
};

module.exports = { log };
