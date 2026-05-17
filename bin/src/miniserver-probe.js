'use strict';

// Pre-authentication probes for the Loxone Miniserver.
//
// Two unauthenticated HTTP(S) calls that have to happen before any of the
// crypto + token plumbing kicks in. Splitting them out as a tiny standalone
// module:
//   - keeps the auth handshake (later in step 5d) focused on the encryption
//     details rather than tangled with reachability checks,
//   - means we can verify the Miniserver is talking to us at all before we
//     trust LoxBerry's stored credentials.
//
// Functions:
//   probeApiKey(msConfig)     → { snr, version, httpsStatus, miniserverType,
//                                 local, hasEventSlots, raw }
//   fetchPublicKey(msConfig)  → string (PEM, with BEGIN/END PUBLIC KEY markers
//                                 substituted in for Loxone's fake cert wrapping)
//
// TLS verification is intentionally disabled (`rejectUnauthorized: false`).
// Loxone Miniservers serve a self-signed cert bound to a CloudDNS hostname
// (<dashed-ip>.<snr>.dyndns.loxonecloud.com); on LAN we reach the device by
// a different name (IP, mDNS '*.home', custom DNS), so the cert won't match
// no matter what. The transport security comes from the LAN trust boundary
// and the per-command Loxone encryption layer that lives one level up.

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 5000;

// Public — apiKey response field shape we care about. Note: `miniserverType`
// and `hasEventSlots` are NOT here despite the protocol summary occasionally
// listing them — they live in the structure file (LoxAPP3.json), not in
// apiKey. apiKey is for reachability + transport choices.
const API_KEY_FIELDS = ['snr', 'version', 'httpsStatus', 'local', 'isInTrust', 'certTLD'];

async function probeApiKey(msConfig, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${msConfig.httpsBase()}/jdev/cfg/apiKey`;
  const body = await getJson(url, { timeoutMs });
  if (!body || !body.LL) {
    throw new Error(`apiKey: unexpected response shape (no LL wrapper): ${truncate(JSON.stringify(body), 200)}`);
  }
  const value = parseLLValue(body.LL.value);
  const code = body.LL.Code;
  if (code !== '200' && code !== 200) {
    throw new Error(`apiKey: Miniserver returned Code=${code}`);
  }

  const out = { raw: value };
  for (const k of API_KEY_FIELDS) out[k] = value[k];
  return out;
}

async function fetchPublicKey(msConfig, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${msConfig.httpsBase()}/jdev/sys/getPublicKey`;
  const body = await getJson(url, { timeoutMs });
  if (!body || !body.LL) {
    throw new Error(`getPublicKey: unexpected response (no LL): ${truncate(JSON.stringify(body), 200)}`);
  }
  const code = body.LL.Code;
  if (code !== '200' && code !== 200) {
    throw new Error(`getPublicKey: Miniserver returned Code=${code}`);
  }
  const value = body.LL.value;
  if (typeof value !== 'string') {
    throw new Error('getPublicKey: value is not a string');
  }
  // Loxone returns the key as a single line with fake X.509 markers and
  // NO newlines between header/body/footer. Two fixes:
  //   1) substitute BEGIN/END PUBLIC KEY for BEGIN/END CERTIFICATE — the
  //      bytes inside are a SubjectPublicKeyInfo, not a real X.509 cert.
  //   2) re-emit as standard PEM with newlines + 64-char body wrapping.
  // Without the wrapping, Node's PEM parser rejects with DECODER errors.
  const keyBytes = value
    .replace('-----BEGIN CERTIFICATE-----', '')
    .replace('-----END CERTIFICATE-----', '')
    .replace(/\s+/g, '');
  const wrapped = keyBytes.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

// --- helpers ---------------------------------------------------------------

// Loxone's "value" field comes in three flavors:
//   - already a JSON object (modern endpoints)
//   - a real JSON-encoded string
//   - a Python-style dict-literal with SINGLE quotes (apiKey is one of these)
// The last one isn't valid JSON, but the only difference is the quote
// character — there are no nested literals with embedded quotes in the
// fields Loxone returns. So flipping `'` → `"` is a safe rewrite.
function parseLLValue(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return {};

  // Try clean JSON first; fall back to single-quote rewrite for Loxone's
  // Python-ish format.
  try {
    return JSON.parse(v);
  } catch {
    try {
      return JSON.parse(v.replace(/'/g, '"'));
    } catch {
      return { _raw: v };
    }
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function getJson(urlString, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (err) { return reject(err); }

    const lib = url.protocol === 'https:' ? https : http;
    const reqOpts = {
      method: 'GET',
      timeout: timeoutMs,
      rejectUnauthorized: false, // see module header for the reasoning
      headers: { Accept: 'application/json' },
    };
    const req = lib.request(url, reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} for ${urlString}: ${truncate(buf, 200)}`));
        }
        try {
          resolve(JSON.parse(buf));
        } catch (err) {
          reject(new Error(`invalid JSON from ${urlString}: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${timeoutMs} ms`));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

module.exports = { probeApiKey, fetchPublicKey };
