#!/usr/bin/env node
// Unit tests for miniserver-events decoders. No network.
'use strict';

const {
  decodeValueEvents, decodeTextEvents,
  decodeDaytimerEvents, decodeWeatherEvents,
  decodeEventPayload, readLoxoneUuid,
} = require('../src/miniserver-events');

let pass = 0, fail = 0;
function ok(label)   { console.log(`  ✓ ${label}`); pass++; }
function nope(label, d) { console.log(`  ✗ ${label}${d ? ': ' + d : ''}`); fail++; }
function check(cond, label, d) { (cond ? ok : nope)(label, d); }
function eq(a, b, label) { check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function test(name, fn) { console.log(`# ${name}`); try { fn(); } catch (e) { nope('threw', e.stack || e.message); } console.log(''); }

// ---- UUID reader -------------------------------------------------------------
test('readLoxoneUuid: byte-order matches Loxone sprintf format', () => {
  // From "Communicating with the Miniserver" p.21 the layout is:
  //   Data1 LE uint32, Data2 LE uint16, Data3 LE uint16, Data4 raw 8 bytes
  // Build a UUID where each section is unique so byte-mis-orderings show up.
  const buf = Buffer.from([
    0x78, 0x56, 0x34, 0x12,             // Data1 LE = 0x12345678
    0xBC, 0x9A,                         // Data2 LE = 0x9ABC
    0xF0, 0xDE,                         // Data3 LE = 0xDEF0
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,  // Data4 raw
  ]);
  eq(readLoxoneUuid(buf, 0), '12345678-9abc-def0-1122334455667788', 'UUID stringification');
});

// ---- Value events ------------------------------------------------------------
test('decodeValueEvents: synthetic two-entry payload', () => {
  // entry 1: UUID 11111111-2222-3333-4444444444444444, value 1.5
  // entry 2: UUID aaaaaaaa-bbbb-cccc-dddddddddddddddd, value -2.0
  const e1 = Buffer.concat([
    Buffer.from([0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x33, 0x33,
                 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44]),
    (() => { const b = Buffer.alloc(8); b.writeDoubleLE(1.5, 0); return b; })(),
  ]);
  const e2 = Buffer.concat([
    Buffer.from([0xaa, 0xaa, 0xaa, 0xaa, 0xbb, 0xbb, 0xcc, 0xcc,
                 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd]),
    (() => { const b = Buffer.alloc(8); b.writeDoubleLE(-2.0, 0); return b; })(),
  ]);
  const events = decodeValueEvents(Buffer.concat([e1, e2]));
  eq(events.length, 2, 'two entries decoded');
  eq(events[0].uuid, '11111111-2222-3333-4444444444444444', 'entry 0 UUID');
  eq(events[0].value, 1.5, 'entry 0 value');
  eq(events[1].uuid, 'aaaaaaaa-bbbb-cccc-dddddddddddddddd', 'entry 1 UUID');
  eq(events[1].value, -2.0, 'entry 1 value');
});

test('decodeValueEvents: rejects non-multiple-of-24 payload', () => {
  let threw = false;
  try { decodeValueEvents(Buffer.alloc(25)); } catch { threw = true; }
  check(threw, 'throws on bad length');
});

test('decodeValueEvents: matches real captured frame entry', () => {
  // First entry from the captured initial-dump frame (see session log):
  // hex: 1469d91b 9802 0635 ffff3b8739cfc0c6 0000000000001040
  // Expected: 1bd96914-0298-3506-ffff3b8739cfc0c6  value=4.0
  const entry = Buffer.from(
    '1469d91b98020635ffff3b8739cfc0c60000000000001040',
    'hex',
  );
  const [decoded] = decodeValueEvents(entry);
  eq(decoded.uuid, '1bd96914-0298-3506-ffff3b8739cfc0c6', 'real-frame UUID');
  eq(decoded.value, 4.0, 'real-frame value (= 4.0 from 0x4010000000000000 LE)');
});

// ---- Text events -------------------------------------------------------------
test('decodeTextEvents: synthetic entry with 2-byte text and padding', () => {
  // UUID(16) + iconUUID(16) + textLength=2 + "[]" + 2 bytes padding to 40-byte boundary
  const uuidBytes = Buffer.from('17000000bb031e37ffff526eb2caca25', 'hex');
  const iconBytes = Buffer.alloc(16, 0);
  const lenBytes = Buffer.alloc(4); lenBytes.writeUInt32LE(2, 0);
  const textBytes = Buffer.from('[]', 'utf8');
  const padBytes = Buffer.from([0, 0]);
  const buf = Buffer.concat([uuidBytes, iconBytes, lenBytes, textBytes, padBytes]);
  const events = decodeTextEvents(buf);
  eq(events.length, 1, 'one entry');
  eq(events[0].uuid, '00000017-03bb-371e-ffff526eb2caca25', 'UUID');
  eq(events[0].iconUuid, '00000000-0000-0000-0000000000000000', 'iconUUID is all-zero');
  eq(events[0].text, '[]', 'text body');
});

test('decodeTextEvents: real captured first entry', () => {
  // From the wire: identifier-3 frame's first entry was a 2-byte "[]" payload
  // with UUID 1bd96917-03bb-371e-ffff526eb2caca25 and no icon.
  // hex prefix: 1769d91b bb03 1e37 ffff526eb2caca25 [16 zero icon bytes] 02000000 5b5d 0000
  const buf = Buffer.from(
    '1769d91bbb031e37ffff526eb2caca25' +
    '00000000000000000000000000000000' +
    '02000000' +
    '5b5d' +
    '0000',
    'hex',
  );
  const events = decodeTextEvents(buf);
  eq(events.length, 1, 'one entry');
  eq(events[0].uuid, '1bd96917-03bb-371e-ffff526eb2caca25', 'real-frame UUID');
  eq(events[0].text, '[]', 'real-frame text');
});

test('decodeTextEvents: two entries (padding handled correctly)', () => {
  const mk = (uuidHex, text) => {
    const u = Buffer.from(uuidHex, 'hex');
    const icon = Buffer.alloc(16, 0);
    const len = Buffer.alloc(4); len.writeUInt32LE(Buffer.byteLength(text), 0);
    const t = Buffer.from(text, 'utf8');
    const consumed = 36 + t.length;
    const pad = (4 - (consumed % 4)) % 4;
    return Buffer.concat([u, icon, len, t, Buffer.alloc(pad, 0)]);
  };
  const buf = Buffer.concat([
    mk('11111111222233334444444444444444', 'a'),       // 1 byte text, 3 bytes pad
    mk('aaaaaaaabbbbccccdddddddddddddddd', 'hello!!'), // 7 bytes text, 1 byte pad
  ]);
  const events = decodeTextEvents(buf);
  eq(events.length, 2, 'two entries');
  eq(events[0].text, 'a', 'first text');
  eq(events[1].text, 'hello!!', 'second text');
});

// ---- Dispatcher --------------------------------------------------------------
test('decodeEventPayload routes by identifier', () => {
  const valueBuf = Buffer.alloc(24);
  valueBuf.writeUInt32LE(0xDEADBEEF, 0);
  const out = decodeEventPayload(2, valueBuf);
  eq(out.kind, 'value', 'identifier 2 → value');
  eq(out.events.length, 1, 'single entry');

  eq(decodeEventPayload(99, Buffer.alloc(0)).kind, 'unknown', 'unknown identifier handled');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
