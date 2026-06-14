#!/usr/bin/env node
// Unit tests for MiniserverPoller. Pure JS — fake sessions, no network.
'use strict';

const EventEmitter = require('node:events');
const { MiniserverPoller } = require('../src/miniserver-poller');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }
function eq(a, b, label) { check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Minimal logger matching the daemon's pino-ish surface.
const fakeLog = {
  child() { return this; },
  info() {}, warn() {}, debug() {}, error() {},
};

// Fake MiniserverSession: emits per the script you give it.
//   behavior: 'subscribe' → emit 'subscribed' shortly after start()
//             'fail'      → emit 'disconnected' shortly after start()
class FakeSession extends EventEmitter {
  constructor({ behavior = 'subscribe', delayMs = 5 } = {}) {
    super();
    this.behavior = behavior;
    this.delayMs = delayMs;
    this.startCalls = 0;
    this.stopCalls = 0;
  }
  async start() {
    this.startCalls++;
    setTimeout(() => {
      if (this.behavior === 'subscribe') this.emit('subscribed');
      else this.emit('disconnected', { reason: 'fake connect failure' });
    }, this.delayMs);
  }
  async stop() { this.stopCalls++; }
}

function makePoller({ behaviors, stateCache, intervalMs = 60, onSession }) {
  // behaviors: array consumed one per cycle; last entry repeats.
  let i = 0;
  const sessions = [];
  const poller = new MiniserverPoller({
    stateCache,
    intervalMs,
    log: fakeLog,
    connectTimeoutMs: 500,
    settleQuietMs: 10,
    settleMaxMs: 300,
    settleTickMs: 5,
    sessionFactory: () => {
      const behavior = behaviors[Math.min(i, behaviors.length - 1)];
      i++;
      const s = new FakeSession({ behavior });
      sessions.push(s);
      if (onSession) onSession(s);
      return s;
    },
  });
  return { poller, sessions };
}

test('successful cycle emits poll-ok with applied event count and stops the session', async () => {
  const stateCache = { eventsSeen: 100 };
  const { poller, sessions } = makePoller({ behaviors: ['subscribe'], stateCache, intervalMs: 60_000 });

  // Simulate the initial dump landing right after subscribe.
  const okEvents = [];
  poller.on('poll-ok', (o) => okEvents.push(o));
  poller.on('poll-failed', (o) => nope('unexpected poll-failed', o.reason));

  poller.start();
  await sleep(10);
  stateCache.eventsSeen = 142;     // dump arrived
  await sleep(80);                 // settle (quiet 10ms, tick 5ms)

  eq(okEvents.length, 1, 'exactly one poll-ok');
  eq(okEvents[0].eventsApplied, 42, 'eventsApplied counts the dump');
  eq(sessions.length, 1, 'one session created');
  eq(sessions[0].stopCalls, 1, 'session stopped after the cycle');
  await poller.stop();
});

test('failed connect emits poll-failed and still stops the session', async () => {
  const stateCache = { eventsSeen: 0 };
  const { poller, sessions } = makePoller({ behaviors: ['fail'], stateCache, intervalMs: 60_000 });

  const failures = [];
  poller.on('poll-failed', (o) => failures.push(o));
  poller.on('poll-ok', () => nope('unexpected poll-ok'));

  poller.start();
  await sleep(60);

  eq(failures.length, 1, 'exactly one poll-failed');
  eq(failures[0].reason, 'fake connect failure', 'reason propagated');
  eq(sessions[0].stopCalls, 1, 'session stopped after failed cycle');
  await poller.stop();
});

test('next cycle is scheduled after the previous one (failure is retried on schedule)', async () => {
  const stateCache = { eventsSeen: 0 };
  const { poller, sessions } = makePoller({
    behaviors: ['fail', 'subscribe'],
    stateCache,
    intervalMs: 40,
  });

  const outcomes = [];
  poller.on('poll-failed', () => outcomes.push('fail'));
  poller.on('poll-ok', () => outcomes.push('ok'));

  poller.start();
  await sleep(200);
  await poller.stop();

  check(sessions.length >= 2, 'a second cycle ran', `sessions=${sessions.length}`);
  eq(outcomes[0], 'fail', 'first cycle failed');
  eq(outcomes[1], 'ok', 'second cycle succeeded');
});

test('disconnect during the settle window fails the cycle', async () => {
  const stateCache = { eventsSeen: 0 };
  let session;
  const { poller } = makePoller({
    behaviors: ['subscribe'],
    stateCache,
    intervalMs: 60_000,
    onSession: (s) => { session = s; },
  });
  // Keep events flowing so settle never goes quiet before the drop.
  const churn = setInterval(() => { stateCache.eventsSeen++; }, 3);

  const failures = [];
  poller.on('poll-failed', (o) => failures.push(o));

  poller.start();
  await sleep(20);                       // subscribed, settling
  session.emit('disconnected', { reason: 'mid-dump drop' });
  await sleep(40);
  clearInterval(churn);

  eq(failures.length, 1, 'cycle reported as failed');
  eq(failures[0].reason, 'mid-dump drop', 'drop reason propagated');
  await poller.stop();
});

test('stop() cancels the schedule — no further cycles', async () => {
  const stateCache = { eventsSeen: 0 };
  const { poller, sessions } = makePoller({
    behaviors: ['subscribe'],
    stateCache,
    intervalMs: 30,
  });
  poller.start();
  await sleep(60);                       // first cycle completes
  const after = sessions.length;
  await poller.stop();
  await sleep(120);                      // would have run ~4 more cycles
  eq(sessions.length, after, 'no new sessions after stop()');
});

test('connect timeout fails the cycle', async () => {
  const stateCache = { eventsSeen: 0 };
  // A session that never emits anything.
  const silent = new (class extends FakeSession {
    async start() { this.startCalls++; }
  })();
  const poller = new MiniserverPoller({
    stateCache,
    intervalMs: 60_000,
    log: fakeLog,
    connectTimeoutMs: 30,
    settleQuietMs: 10,
    settleMaxMs: 100,
    settleTickMs: 5,
    sessionFactory: () => silent,
  });
  const failures = [];
  poller.on('poll-failed', (o) => failures.push(o));
  poller.start();
  await sleep(80);
  eq(failures.length, 1, 'timeout produced poll-failed');
  check(/timeout/.test(failures[0].reason), 'reason mentions timeout', failures[0].reason);
  eq(silent.stopCalls, 1, 'session stopped after timeout');
  await poller.stop();
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
