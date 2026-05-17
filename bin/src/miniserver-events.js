'use strict';

// Decoders for Loxone binary event-table payloads.
//
// Each event-table arrives as a single binary WS frame whose header (already
// consumed by miniserver-ws.js) tells us the kind (identifier 2..7) and the
// payload length. This module turns the payload buffer into structured JS
// objects.
//
// Layouts taken from "Communicating with the Miniserver" v17.0 pp.19-21 and
// the bundled websocket-flow.md in the loxberry-miniserver-comms skill.

const ID_VALUE_EVENTS = 2;
const ID_TEXT_EVENTS = 3;
const ID_DAYTIMER_EVENTS = 4;
const ID_WEATHER_EVENTS = 7;

// ---- UUID --------------------------------------------------------------------

// Loxone UUID: 16 bytes.
//   bytes  0..3 : Data1 (uint32 LE) → 8 hex chars
//   bytes  4..5 : Data2 (uint16 LE) → 4 hex chars
//   bytes  6..7 : Data3 (uint16 LE) → 4 hex chars
//   bytes  8..15: Data4 (8 raw bytes) → 16 hex chars
// Stringified with hyphens: "DDDDDDDD-DDDD-DDDD-DDDDDDDDDDDDDDDD"
function readLoxoneUuid(buf, off) {
  const d1 = buf.readUInt32LE(off).toString(16).padStart(8, '0');
  const d2 = buf.readUInt16LE(off + 4).toString(16).padStart(4, '0');
  const d3 = buf.readUInt16LE(off + 6).toString(16).padStart(4, '0');
  const d4 = buf.subarray(off + 8, off + 16).toString('hex');
  return `${d1}-${d2}-${d3}-${d4}`;
}

// ---- Value events (identifier 2) ---------------------------------------------

// Fixed-size 24-byte entries: UUID(16) + double(8 LE).
function decodeValueEvents(buf) {
  if (buf.length % 24 !== 0) {
    throw new Error(`decodeValueEvents: payload length ${buf.length} is not a multiple of 24`);
  }
  const events = [];
  for (let off = 0; off < buf.length; off += 24) {
    events.push({
      uuid: readLoxoneUuid(buf, off),
      value: buf.readDoubleLE(off + 16),
    });
  }
  return events;
}

// ---- Text events (identifier 3) ----------------------------------------------

// Variable-size entries, each 4-byte aligned:
//   UUID(16) + iconUUID(16) + textLength(uint32 LE) + text(textLength bytes)
//   + zero padding to next 4-byte boundary.
function decodeTextEvents(buf) {
  const events = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 36 > buf.length) {
      throw new Error(`decodeTextEvents: truncated header at offset ${off} (need 36 bytes, have ${buf.length - off})`);
    }
    const uuid = readLoxoneUuid(buf, off);
    const iconUuid = readLoxoneUuid(buf, off + 16);
    const textLength = buf.readUInt32LE(off + 32);
    const textStart = off + 36;
    const textEnd = textStart + textLength;
    if (textEnd > buf.length) {
      throw new Error(`decodeTextEvents: text body extends past payload at offset ${off}`);
    }
    const text = buf.subarray(textStart, textEnd).toString('utf8');
    events.push({ uuid, iconUuid, text });

    // Advance to next 4-byte boundary (padding bytes are zero).
    const consumed = 36 + textLength;
    const pad = (4 - (consumed % 4)) % 4;
    off += consumed + pad;
  }
  return events;
}

// ---- Daytimer events (identifier 4) — skeleton, parsed lazily ----------------

// Daytimer schedules. Each top-level record:
//   UUID(16) + defaultValue(8 LE double) + nrEntries(4 LE uint32) +
//   nrEntries × Entry(24).
// Per-entry layout (24 bytes):
//   mode(int32 LE) + from(int32 LE, minutes since midnight) +
//   to(int32 LE)   + needActivate(int32 LE 0/1) + value(double LE).
//
// (The loxberry-miniserver-comms skill says "28-byte entries" in its summary
// table but the struct definition immediately below sums to 24. Live wire
// data confirms 24 is correct.)
//
// We don't use daytimer schedules for Alexa Smart Home — skip the per-entry
// parsing for now, just walk the records to consume the bytes.
function decodeDaytimerEvents(buf) {
  const HEADER = 28;
  const ENTRY = 24;
  const events = [];
  let off = 0;
  while (off + HEADER <= buf.length) {
    const uuid = readLoxoneUuid(buf, off);
    const defaultValue = buf.readDoubleLE(off + 16);
    const nrEntries = buf.readUInt32LE(off + 24);
    const end = off + HEADER + nrEntries * ENTRY;
    if (end > buf.length) {
      throw new Error(`decodeDaytimerEvents: truncated at offset ${off} (need ${end}, have ${buf.length})`);
    }
    events.push({ uuid, defaultValue, nrEntries, entries: undefined });
    off = end;
  }
  return events;
}

// ---- Weather events (identifier 7) — skeleton -------------------------------

function decodeWeatherEvents(buf) {
  // Each entry: UUID(16) + lastUpdate(4 LE) + nrEntries(4 LE) + nrEntries × 68 bytes.
  // Loxone weather entry: 5 int32 (20) + 6 double (48) = 68 bytes.
  const events = [];
  let off = 0;
  while (off + 24 <= buf.length) {
    const uuid = readLoxoneUuid(buf, off);
    const lastUpdate = buf.readUInt32LE(off + 16);
    const nrEntries = buf.readUInt32LE(off + 20);
    const end = off + 24 + nrEntries * 68;
    if (end > buf.length) {
      throw new Error(`decodeWeatherEvents: truncated at offset ${off}`);
    }
    events.push({ uuid, lastUpdate, nrEntries, entries: undefined });
    off = end;
  }
  return events;
}

// ---- Top-level dispatcher ----------------------------------------------------

function decodeEventPayload(identifier, buf) {
  switch (identifier) {
    case ID_VALUE_EVENTS:    return { kind: 'value',    events: decodeValueEvents(buf) };
    case ID_TEXT_EVENTS:     return { kind: 'text',     events: decodeTextEvents(buf) };
    case ID_DAYTIMER_EVENTS: return { kind: 'daytimer', events: decodeDaytimerEvents(buf) };
    case ID_WEATHER_EVENTS:  return { kind: 'weather',  events: decodeWeatherEvents(buf) };
    default:
      return { kind: 'unknown', identifier, length: buf.length };
  }
}

module.exports = {
  decodeEventPayload,
  decodeValueEvents,
  decodeTextEvents,
  decodeDaytimerEvents,
  decodeWeatherEvents,
  readLoxoneUuid,
  ID_VALUE_EVENTS,
  ID_TEXT_EVENTS,
  ID_DAYTIMER_EVENTS,
  ID_WEATHER_EVENTS,
};
