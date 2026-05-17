'use strict';

// Generate a 10-character pair code from a 32-character "unambiguous" alphabet.
//
// Alphabet choice (user-confirmed): uppercase letters + digits with the
// classically-ambiguous characters removed:
//
//   removed letters: I, O   (look like 1 and 0)
//   removed digits:  0, 1   (look like O and I/L)
//
// What remains is exactly 32 characters, so each character carries a uniform
// 5 bits when drawn from `crypto.randomBytes` — 10 chars = 50 bits of entropy.
//
// Why 50 bits is enough for THIS use:
// — codes are one-shot. First `GET /pair?code=X` on the bridge deletes the
//   entry. Subsequent gets return 404. So the attacker has exactly one
//   chance per code.
// — codes expire after ~10 minutes regardless.
// — the bridge sits behind X-Bridge-Auth on the GET side. An external
//   attacker without that secret can't even attempt a code lookup.
// Brute-force at any plausible request rate is hopeless within the
// validity window; the code is a *transport*, not a long-term key.

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

if (ALPHABET.length !== 32) {
  // Boot-time assertion — if someone edits the alphabet to a non-power-of-2
  // size, the (byte & 0x1f) trick would introduce bias. Fail loudly here.
  throw new Error(`pair-code alphabet must be exactly 32 chars, got ${ALPHABET.length}`);
}

const CODE_LENGTH = 10;
// Matches the alphabet exactly. Note the explicit gaps to exclude I, O
// (which look like 1 and 0). 0 and 1 are already outside the 2-9 range.
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;

function generate() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // 32-char alphabet, 5 bits per char, no modulo bias.
    out += ALPHABET[bytes[i] & 0x1f];
  }
  return out;
}

function isValid(code) {
  return typeof code === 'string' && CODE_PATTERN.test(code);
}

module.exports = { generate, isValid, ALPHABET, CODE_LENGTH, CODE_PATTERN };
