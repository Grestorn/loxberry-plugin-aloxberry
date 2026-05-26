#!/usr/bin/env node
// Unit tests for the OAuth hardening: PKCE (RFC 7636) verifier handling and
// token-endpoint client-credential parsing (RFC 6749 §2.3). Pure functions
// only — no AWS, no network. Same minimal harness style as bin/test/*.cjs.
'use strict';

const { _test } = require('./index');
const {
  isValidCodeVerifier, pkceS256Challenge, verifyPkce,
  parseClientCredentials, timingSafeEqualStrings,
  isAllowedRedirectUri,
  pickLocale, normalizeLocale, t,
} = _test;

let pass = 0, fail = 0;
function ok(l)        { console.log(`  ✓ ${l}`); pass++; }
function nope(l, d)   { console.log(`  ✗ ${l}${d ? ': ' + d : ''}`); fail++; }
function check(c, l, d) { (c ? ok : nope)(l, d); }
function eq(a, b, l)  { check(a === b, l, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function test(n, fn)  { console.log(`# ${n}`); try { fn(); } catch (e) { nope('threw', e.stack || e.message); } console.log(''); }

test('isValidCodeVerifier enforces RFC 7636 §4.1 charset/length', () => {
  eq(isValidCodeVerifier('a'.repeat(43)), true,  '43 chars min OK');
  eq(isValidCodeVerifier('a'.repeat(128)), true, '128 chars max OK');
  eq(isValidCodeVerifier('a'.repeat(42)), false, '42 too short');
  eq(isValidCodeVerifier('a'.repeat(129)), false,'129 too long');
  eq(isValidCodeVerifier('-._~' + 'A'.repeat(39)), true, 'unreserved set OK');
  eq(isValidCodeVerifier('a'.repeat(42) + '/'), false, 'illegal char rejected');
  eq(isValidCodeVerifier(undefined), false, 'non-string rejected');
});

test('pkceS256Challenge matches the RFC 7636 Appendix B vector', () => {
  // RFC 7636 Appendix B — the canonical interop test vector.
  const verifier  = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected  = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  eq(pkceS256Challenge(verifier), expected, 'S256 base64url(no pad) exact');
});

test('verifyPkce — no stored challenge means PKCE not in play', () => {
  eq(verifyPkce({ storedChallenge: undefined }).ok, true, 'absent challenge → pass');
  eq(verifyPkce({ storedChallenge: '' }).ok, true, 'empty challenge → pass');
});

test('verifyPkce — stored challenge is enforced', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  eq(verifyPkce({ storedChallenge: challenge, storedMethod: 'S256', codeVerifier: verifier }).ok,
     true, 'correct verifier → ok');

  const wrong = verifyPkce({ storedChallenge: challenge, storedMethod: 'S256',
    codeVerifier: 'x'.repeat(43) });
  eq(wrong.ok, false, 'wrong verifier → fail');
  eq(wrong.error, 'invalid_grant', 'fail maps to invalid_grant');

  eq(verifyPkce({ storedChallenge: challenge, storedMethod: 'S256' }).ok,
     false, 'missing verifier when challenge stored → fail');

  eq(verifyPkce({ storedChallenge: challenge, storedMethod: 'plain', codeVerifier: verifier }).ok,
     false, 'non-S256 stored method → fail (no downgrade)');

  eq(verifyPkce({ storedChallenge: challenge, storedMethod: 'S256', codeVerifier: 'short' }).ok,
     false, 'malformed verifier → fail');
});

test('parseClientCredentials — Basic header (urlencoded halves)', () => {
  // "cli ent" : "sec/ret" url-encoded then base64, per RFC 6749 §2.3.1.
  const raw = `${encodeURIComponent('cli ent')}:${encodeURIComponent('sec/ret')}`;
  const b64 = Buffer.from(raw).toString('base64');
  const ev  = { headers: { authorization: `Basic ${b64}` } };
  const c   = parseClientCredentials(ev, {});
  eq(c.id, 'cli ent', 'client_id url-decoded');
  eq(c.secret, 'sec/ret', 'client_secret url-decoded');
  eq(c.source, 'basic', 'source=basic');
});

test('parseClientCredentials — body fallback + Basic precedence', () => {
  const body = parseClientCredentials({ headers: {} }, { client_id: 'bid', client_secret: 'bsec' });
  eq(body.id, 'bid', 'body client_id');
  eq(body.source, 'body', 'source=body');

  const b64 = Buffer.from('hid:hsec').toString('base64');
  const both = parseClientCredentials(
    { headers: { authorization: `Basic ${b64}` } },
    { client_id: 'bid', client_secret: 'bsec' });
  eq(both.id, 'hid', 'Basic wins over body (RFC 6749 §2.3.1)');

  const none = parseClientCredentials({ headers: {} }, {});
  eq(none.source, 'none', 'absent → source=none');
});

test('timingSafeEqualStrings', () => {
  eq(timingSafeEqualStrings('abc', 'abc'), true,  'equal');
  eq(timingSafeEqualStrings('abc', 'abd'), false, 'unequal same length');
  eq(timingSafeEqualStrings('abc', 'abcd'), false,'different length');
  eq(timingSafeEqualStrings('', ''), true, 'empty equal');
  eq(timingSafeEqualStrings(undefined, 'x'), false, 'non-string safe');
});

test('isAllowedRedirectUri — only the 3 documented Alexa hosts (regression for the host-spoof bypass)', () => {
  // Legit Alexa account-linking hosts.
  eq(isAllowedRedirectUri('https://pitangui.amazon.com/api/skill/link/X'), true,  'pitangui (NA)');
  eq(isAllowedRedirectUri('https://layla.amazon.com/api/skill/link/X'),    true,  'layla (EU)');
  eq(isAllowedRedirectUri('https://alexa.amazon.co.jp/api/skill/link/X'),  true,  'alexa.co.jp (FE)');
  eq(isAllowedRedirectUri('https://LAYLA.AMAZON.COM/x'),                   true,  'case-insensitive host');

  // The exact bypass the old /(^|\.)amazon\.[a-z.]+$/ regex allowed.
  eq(isAllowedRedirectUri('https://amazon.evil.com/cb'),        false, 'amazon.<attacker> rejected');
  eq(isAllowedRedirectUri('https://x.amazon.evil.com/cb'),      false, '*.amazon.<attacker> rejected');
  eq(isAllowedRedirectUri('https://pitangui.amazon.com.evil.com/cb'), false, 'suffix-append rejected');
  eq(isAllowedRedirectUri('https://notpitangui.amazon.com/cb'), false, 'prefix-glued host rejected');
  eq(isAllowedRedirectUri('https://amazon.com/cb'),             false, 'bare amazon.com rejected');
  eq(isAllowedRedirectUri('https://alexa.amazon.de/cb'),        false, 'undocumented .de host rejected');

  // Scheme + junk.
  eq(isAllowedRedirectUri('http://pitangui.amazon.com/cb'),     false, 'http:// rejected');
  eq(isAllowedRedirectUri('not a url'),                         false, 'unparseable rejected');
  eq(isAllowedRedirectUri('https://pitangui.amazon.com@evil.com/cb'), false, 'userinfo-confusion → host is evil.com, rejected');
});

test('pickLocale — Accept-Language parsing (RFC 4647 lookup)', () => {
  // Exact primary-tag matches in our supported set.
  eq(pickLocale('de'),                              'de', 'plain de');
  eq(pickLocale('fr'),                              'fr', 'plain fr');
  eq(pickLocale('it'),                              'it', 'plain it');
  eq(pickLocale('es'),                              'es', 'plain es');
  eq(pickLocale('nl'),                              'nl', 'plain nl');
  eq(pickLocale('en'),                              'en', 'plain en');

  // Region-tagged tags strip down to primary.
  eq(pickLocale('de-DE'),                           'de', 'de-DE → de');
  eq(pickLocale('en-GB'),                           'en', 'en-GB → en');
  eq(pickLocale('fr-CA'),                           'fr', 'fr-CA → fr');
  eq(pickLocale('es-MX'),                           'es', 'es-MX → es');
  eq(pickLocale('nl-NL'),                           'nl', 'nl-NL → nl');
  eq(pickLocale('nl-BE'),                           'nl', 'nl-BE → nl');

  // Quality-weight ordering.
  eq(pickLocale('fr-FR,fr;q=0.9,en;q=0.8'),         'fr', 'fr-FR wins');
  eq(pickLocale('en;q=0.5,de;q=0.9'),               'de', 'de beats en on q');
  eq(pickLocale('zh;q=1,de;q=0.5'),                 'de', 'unsupported high-q skipped, de wins');

  // Unsupported primary languages fall back to default.
  eq(pickLocale('pl'),                              'en', 'pl unsupported → en');
  eq(pickLocale('sv-SE'),                           'en', 'sv-SE unsupported → en');
  eq(pickLocale('ja,zh,ko'),                        'en', 'all unsupported → en');

  // Edge inputs.
  eq(pickLocale(''),                                'en', 'empty → en');
  eq(pickLocale(undefined),                         'en', 'undefined → en');
  eq(pickLocale('*'),                               'en', 'wildcard → en');
  eq(pickLocale('de;q=0'),                          'en', 'q=0 ignored → en');
  eq(pickLocale('  DE-de  ,  en ;  q=0.8  '),       'de', 'whitespace + case tolerated');
});

test('normalizeLocale — clamps tampered input to a known locale', () => {
  eq(normalizeLocale('de'), 'de', 'known passes');
  eq(normalizeLocale('en'), 'en', 'default passes');
  eq(normalizeLocale('pl'), 'en', 'unsupported → default');
  eq(normalizeLocale(''),   'en', 'empty → default');
  eq(normalizeLocale('<script>'), 'en', 'injection attempt → default');
});

test('t — translation lookup, fallback, and {var} interpolation', () => {
  // Known key in known locale.
  eq(t('de', 'auth_form.button'), 'Diesen Aloxberry verknüpfen', 'de translation');
  eq(t('fr', 'auth_form.button'), 'Lier cet Aloxberry',          'fr translation');

  // Unknown locale falls back to English.
  eq(t('pl', 'auth_form.button'), 'Link this Aloxberry',         'pl falls back to en');
  eq(t(undefined, 'auth_form.button'), 'Link this Aloxberry',    'undefined falls back to en');

  // Unknown key returns key itself (loud failure mode).
  eq(t('de', 'no_such_key'), 'no_such_key', 'unknown key surfaces itself');

  // Variable interpolation.
  eq(t('en', 'pair.err_http_status', { status: 502 }),
     'Bridge returned an unexpected HTTP 502. Try again shortly.',
     'status interpolated');
  eq(t('de', 'pair.err_timeout', { ms: 5000 }),
     'Die Bridge hat nicht innerhalb von 5000 ms geantwortet. Bitte erneut versuchen.',
     'ms interpolated (de)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
