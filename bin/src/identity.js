'use strict';

// Persistent daemon identity: userId + skillSecret.
//
// Replaces the BRIDGE_CONNECTION_CREDENTIAL env-var flow. Both values are
// generated locally on first boot and persisted to disk in the LoxBerry
// per-plugin config directory ($LBPCONFIG/alexa-aloxberry). They survive
// restarts, plugin upgrades, and box reboots; they're rotated only by an
// explicit user action ("kill all pairings" on the config UI).
//
// File layout (under identityDir, default $DATA_DIR/identity):
//   userId        — 16 random bytes, base64url-encoded (22 chars in [A-Za-z0-9_-])
//   skillSecret   — 32 random bytes, hex-encoded (64 chars in [0-9a-f])
//
// Both files are chmod 0600. The skillSecret is the HMAC key Lambda and
// daemon share; if it leaks, the Alexa side can sign arbitrary directives
// to this daemon. The userId is just a routing key — non-secret, but a
// stable userId across pairings is how multiple Alexa accounts can drive
// the same daemon under Path B (one-shot pair codes carry the SAME
// identity tuple every time; "Recreate code" doesn't rotate it).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_USER_ID = 'userId';
const FILE_SKILL_SECRET = 'skillSecret';

// Pattern checks for sanity — if a file is hand-edited to junk we'd rather
// regenerate cleanly than try to use whatever's there.
const USER_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SKILL_SECRET_RE = /^[0-9a-f]{64}$/i;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readSafe(p, validate) {
  try {
    const text = fs.readFileSync(p, 'utf8').trim();
    return validate(text) ? text : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // Any other read error: surface it. Corrupt FS / permission issue is
    // not something we want to paper over silently.
    throw err;
  }
}

function writeSecret(p, text) {
  // O_WRONLY|O_CREAT|O_TRUNC with 0600. fs.writeFileSync with mode applies
  // the mode only on creation, so we open explicitly to also enforce the
  // mode on overwrite (e.g. when rotating).
  const fd = fs.openSync(p, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fchmodSync(fd, 0o600); // belt + braces
  } finally {
    fs.closeSync(fd);
  }
}

function generateUserId() {
  return crypto.randomBytes(16).toString('base64url');
}

function generateSkillSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// Load existing identity from disk, or generate + persist a fresh one.
// Returns an object with the loaded values plus a `wasCreated` flag so the
// caller can log first-boot vs. resume.
function loadOrCreate({ identityDir, log }) {
  ensureDir(identityDir);
  const userIdPath = path.join(identityDir, FILE_USER_ID);
  const skillSecretPath = path.join(identityDir, FILE_SKILL_SECRET);

  const hadUserIdFile      = fs.existsSync(userIdPath);
  const hadSkillSecretFile = fs.existsSync(skillSecretPath);

  let userId = readSafe(userIdPath, (v) => USER_ID_RE.test(v));
  let skillSecret = readSafe(skillSecretPath, (v) => SKILL_SECRET_RE.test(v));
  let wasCreated = false;

  if (!userId) {
    userId = generateUserId();
    writeSecret(userIdPath, userId);
    wasCreated = true;
    // WARN, not INFO — regenerating identity is a major event that
    // invalidates every existing Alexa pairing on this daemon. If you see
    // this in a log without expecting it, the identity file is missing or
    // corrupted and existing Alexa links will stop working until re-paired.
    log?.warn?.(
      { identityDir, fileExisted: hadUserIdFile, newUserId: userId },
      'identity: generated new userId (existing Alexa pairings invalidated)',
    );
  } else {
    // Log the loaded case at INFO so a normal startup confirms which
    // identity is in use — helpful to spot two-daemon-on-one-host
    // misconfigurations where each daemon has a different identity file.
    log?.info?.({ identityDir, userId }, 'identity: loaded existing userId');
  }
  if (!skillSecret) {
    skillSecret = generateSkillSecret();
    writeSecret(skillSecretPath, skillSecret);
    wasCreated = true;
    log?.warn?.(
      { identityDir, fileExisted: hadSkillSecretFile },
      'identity: generated new skillSecret (existing Alexa pairings invalidated)',
    );
  }

  return {
    userId,
    skillSecret,                              // hex string
    skillSecretBytes: Buffer.from(skillSecret, 'hex'),
    wasCreated,
    userIdPath,
    skillSecretPath,
  };
}

// Rotate both values. Used by the "kill all pairings" CGI action. Returns
// the same shape as loadOrCreate. The bridge connection must be torn down
// and reopened after this so the new userId reaches the bridge.
function rotate({ identityDir, log }) {
  ensureDir(identityDir);
  const userIdPath = path.join(identityDir, FILE_USER_ID);
  const skillSecretPath = path.join(identityDir, FILE_SKILL_SECRET);

  const userId = generateUserId();
  const skillSecret = generateSkillSecret();
  writeSecret(userIdPath, userId);
  writeSecret(skillSecretPath, skillSecret);
  log?.warn?.({ identityDir }, 'identity: ROTATED userId + skillSecret (existing Alexa links are now invalid)');

  return {
    userId,
    skillSecret,
    skillSecretBytes: Buffer.from(skillSecret, 'hex'),
    wasCreated: true,
    userIdPath,
    skillSecretPath,
  };
}

module.exports = {
  loadOrCreate,
  rotate,
  // Exposed for tests + the local-http handler to validate inbound shapes.
  USER_ID_RE,
  SKILL_SECRET_RE,
  generateUserId,
  generateSkillSecret,
};
