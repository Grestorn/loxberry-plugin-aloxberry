#!/usr/bin/env node
// Unit tests for MiniserverSession's authentication / self-heal logic.
// Pure JS — a fake WS client is injected via the wsClientFactory hook, so
// no network, no crypto handshake against a real Miniserver.
'use strict';

const { MiniserverSession } = require('../src/miniserver-session');

let pass = 0, fail = 0;
function ok(label)      { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }
function eq(a, b, label) { check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function once(emitter, event, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    emitter.once(event, (arg) => { clearTimeout(t); resolve(arg); });
  });
}

const fakeLog = { child() { return this; }, info() {}, warn() {}, debug() {}, error() {} };

// getkey2 always answers with hex key + a supported hashAlg so the real
// crypto helpers run without throwing.
const KEY2_OK = { LL: { Code: '200', value: { key: 'abcdef0123456789', salt: 'deadbeef', hashAlg: 'SHA256' } } };
// validUntil far in the future (Loxone seconds-since-2009 epoch).
const JWT_OK  = { LL: { Code: '200', value: { token: 'fresh-jwt', key: 'cafe', validUntil: 4_000_000_000 } } };

// A fake WS client. `script` maps a command-substring → response (or a
// function/throw). Records every sendEncrypted command it saw.
class FakeWs {
  constructor(script) {
    this.script = script;
    this.sent = [];
    this.stopped = false;
    this._handlers = {};
  }
  async start() {}
  on(evt, cb) { this._handlers[evt] = cb; }
  async subscribeBinaryEvents() {}
  async stop() { this.stopped = true; }
  async sendEncrypted(cmd) {
    this.sent.push(cmd);
    for (const [needle, resp] of this.script) {
      if (cmd.includes(needle)) {
        if (typeof resp === 'function') return resp(cmd);
        if (resp instanceof Error) throw resp;
        return resp;
      }
    }
    throw new Error(`FakeWs: no scripted response for ${cmd}`);
  }
}

// Fake token store recording load/save/clear.
function makeTokenStore(initial) {
  return {
    loaded: 0, saved: null, cleared: 0,
    current: initial || null,
    async load() { this.loaded++; return this.current; },
    async save(tok) { this.saved = tok; this.current = tok; },
    async clear() { this.cleared++; this.current = null; },
  };
}

const CACHED = { username: 'alexa', token: 'old-jwt', key: 'abcdef01', validUntil: 4_000_000_000 };

function makeSession({ connections, tokenStore, getCredentials }) {
  // connections: array of FakeWs, one per _connectOnce attempt.
  const created = [];
  let i = 0;
  const session = new MiniserverSession({
    msConfig: { name: 'test', ip: '10.0.0.1', port: 80 },
    publicKey: 'pk',
    daemonUuid: 'uuid-1',
    tokenStore,
    getCredentials: getCredentials || (async () => ({ username: 'alexa', password: 'pw' })),
    log: fakeLog,
    autoReconnect: false,           // poll-mode semantics: one cycle, no internal retry loop
    wsClientFactory: () => {
      const ws = connections[Math.min(i, connections.length - 1)];
      i++;
      created.push(ws);
      return ws;
    },
  });
  return { session, created };
}

test('rejected cached token (Code=401) is discarded and getjwt runs on a fresh socket', async () => {
  const ws1 = new FakeWs([
    ['getkey2', KEY2_OK],
    ['authwithtoken', { LL: { Code: '401' } }],   // Miniserver rejects the token
  ]);
  const ws2 = new FakeWs([
    ['getkey2', KEY2_OK],
    ['getjwt', JWT_OK],
  ]);
  const tokenStore = makeTokenStore(CACHED);
  const { session, created } = makeSession({ connections: [ws1, ws2], tokenStore });

  const subscribed = once(session, 'subscribed');
  await session.start();
  await subscribed;

  eq(created.length, 2, 'a second (fresh) connection was opened');
  eq(tokenStore.cleared, 1, 'the stale cached token was cleared');
  eq(ws1.stopped, true, 'the first socket was torn down');
  check(ws2.sent.some((c) => c.includes('getjwt')), 'getjwt ran on the fresh socket');
  check(!ws2.sent.some((c) => c.includes('authwithtoken')), 'fresh socket did not retry authwithtoken');
  eq(tokenStore.saved && tokenStore.saved.token, 'fresh-jwt', 'the new token was cached');
  await session.stop();
});

test('socket-level failure during cached auth retries fresh but keeps the token', async () => {
  const ws1 = new FakeWs([
    ['getkey2', KEY2_OK],
    ['authwithtoken', new Error('socket closed (1000) before response')],  // no server answer
  ]);
  const ws2 = new FakeWs([
    ['getkey2', KEY2_OK],
    ['getjwt', JWT_OK],
  ]);
  const tokenStore = makeTokenStore(CACHED);
  const { session, created } = makeSession({ connections: [ws1, ws2], tokenStore });

  const subscribed = once(session, 'subscribed');
  await session.start();
  await subscribed;

  eq(created.length, 2, 'retried on a fresh connection');
  eq(tokenStore.cleared, 0, 'token NOT cleared on a non-rejection failure');
  check(ws2.sent.some((c) => c.includes('getjwt')), 'getjwt ran on the fresh socket');
  await session.stop();
});

test('valid cached token authenticates on the first socket — no getjwt, no extra connection', async () => {
  const ws1 = new FakeWs([
    ['getkey2', KEY2_OK],
    ['authwithtoken', { LL: { Code: '200' } }],
  ]);
  const tokenStore = makeTokenStore(CACHED);
  const { session, created } = makeSession({ connections: [ws1], tokenStore });

  const subscribed = once(session, 'subscribed');
  await session.start();
  await subscribed;

  eq(created.length, 1, 'only one connection used');
  eq(tokenStore.cleared, 0, 'good token not cleared');
  check(!ws1.sent.some((c) => c.includes('getjwt')), 'getjwt was not called');
  await session.stop();
});

test('the self-heal retry happens at most once — a failing getjwt fails the cycle', async () => {
  const ws1 = new FakeWs([
    ['getkey2', KEY2_OK],
    ['authwithtoken', { LL: { Code: '401' } }],
  ]);
  const ws2 = new FakeWs([
    ['getkey2', KEY2_OK],
    ['getjwt', { LL: { Code: '401' } }],          // credentials bad too (e.g. password changed)
  ]);
  const tokenStore = makeTokenStore(CACHED);
  const { session, created } = makeSession({ connections: [ws1, ws2], tokenStore });

  const disconnected = once(session, 'disconnected');
  await session.start();
  const info = await disconnected;

  eq(created.length, 2, 'retried exactly once (no third connection)');
  check(/getjwt failed/.test(info.reason), 'cycle failed with the getjwt error', info.reason);
  await session.stop();
});

(async () => {
  for (const { name, fn } of tests) {
    console.log(`# ${name}`);
    try { await fn(); } catch (e) { nope('threw', e.stack || e.message); }
    console.log('');
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
