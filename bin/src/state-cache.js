'use strict';

// In-memory UUID → state cache for Loxone control state.
//
// The cache holds the *most recent* value (or text) per Loxone UUID. It's the
// daemon's source of truth for "what's the current state of device X?", used
// by the directive handler in step 6 to answer Alexa ReportState requests
// and by state-reporter to detect transitions worth reporting to Alexa
// (Phase 4 proactive ChangeReports).
//
// Two maps because Loxone keeps value-states and text-states separate (per
// the binary event-table layout). A single UUID can in principle appear in
// both (rare but possible), so they're kept distinct.
//
// In-memory only. On daemon restart we re-subscribe to enablebinstatusupdate,
// which makes the Miniserver re-push the entire initial dump within seconds —
// faster than disk replay would be, and authoritative. The flip side: every
// re-subscribe looks like a flood of "new states" to any consumer. We avoid
// turning that flood into a ChangeReport storm by emitting `change` events
// only when a value *transitions* (prev → next where they differ), not on
// first insertion of a UUID.

const EventEmitter = require('node:events');

class MiniserverStateCache extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.values = new Map();    // uuid → { value: number,  updatedAt: ms }
    this.texts  = new Map();    // uuid → { text:  string,  updatedAt: ms }
    this.eventsSeen = 0;        // running count across the entire daemon run
    this.lastEventAt = null;    // ms timestamp of most recent applied event
    this._now = now;
  }

  // Apply a decoded event batch (output of decodeEventPayload).
  // Emits a 'change' event per transition (NOT per insertion) so consumers
  // can react only to real-world state changes:
  //   { kind: 'value'|'text', uuid, prev, value }   (value events)
  //   { kind: 'text', uuid, prev, text }            (text events)
  ingest(decoded) {
    if (!decoded || !decoded.kind) return 0;
    const now = this._now();
    let applied = 0;

    switch (decoded.kind) {
      case 'value':
        for (const ev of decoded.events) {
          const prev = this.values.get(ev.uuid);
          this.values.set(ev.uuid, { value: ev.value, updatedAt: now });
          applied++;
          // Emit only on *transition* — first occurrence of a UUID is a
          // post-subscribe initial-state push, not a user-visible change.
          if (prev && prev.value !== ev.value) {
            this.emit('change', {
              kind:  'value',
              uuid:  ev.uuid,
              prev:  prev.value,
              value: ev.value,
            });
          }
        }
        break;
      case 'text':
        for (const ev of decoded.events) {
          const prev = this.texts.get(ev.uuid);
          this.texts.set(ev.uuid, { text: ev.text, updatedAt: now });
          applied++;
          if (prev && prev.text !== ev.text) {
            this.emit('change', {
              kind: 'text',
              uuid: ev.uuid,
              prev: prev.text,
              text: ev.text,
            });
          }
        }
        break;
      case 'daytimer':
      case 'weather':
        // Out of scope for Alexa Smart Home — count them so state.miniserver
        // can report "we're seeing traffic" but don't store the bodies.
        applied = decoded.events.length;
        break;
      default:
        return 0;
    }

    if (applied > 0) {
      this.eventsSeen += applied;
      this.lastEventAt = now;
    }
    return applied;
  }

  getValue(uuid) { return this.values.get(uuid); }
  getText(uuid)  { return this.texts.get(uuid); }
  hasUuid(uuid)  { return this.values.has(uuid) || this.texts.has(uuid); }

  // Snapshot fields for state.miniserver.* in state.json. Intentionally
  // omits the per-UUID values — too large for the CGI status page. A
  // dedicated /api/state/<uuid> endpoint is the right place for those
  // when the UI needs them.
  snapshotSummary() {
    return {
      eventsSeen: this.eventsSeen,
      valueCount: this.values.size,
      textCount: this.texts.size,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
    };
  }
}

module.exports = { MiniserverStateCache };
