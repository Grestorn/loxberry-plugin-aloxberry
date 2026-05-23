'use strict';

// Miniserver WebSocket client. Step 5d.1 scope: open the socket, run the
// RSA key exchange, expose `sendCommand(cmd, controlPrefix)` for follow-up
// steps. Authentication (getjwt) and encrypted commands land in 5d.2/5d.3.
//
// Wire framing recap (websocket-flow.md):
//   - Outbound: a single WS TEXT frame per command (e.g. "jdev/sys/...")
//   - Inbound:  PAIRS of (header binary frame, payload frame).
//                 byte 0:  0x03 magic
//                 byte 1:  identifier (0=Text response, 2..7=event tables, 6=keepalive)
//                 byte 2:  info flags (bit 0 = "estimated size", skip the payload)
//                 byte 3:  reserved
//                 bytes 4..7: payload length (uint32 LE)
//     Identifier=0 → payload is a UTF-8 text frame (JSON, matches our requests).
//     Identifier=6 with length=0 → keepalive reply; no payload follows.
//     Identifier=2..7 → binary event tables; later step decodes these.
//
// `ws` library: emits `message` events with (data, isBinary). We use that
// alone to distinguish header-binary frames from text-payload frames.

const EventEmitter = require('node:events');
const WebSocket = require('ws');

const c = require('./miniserver-crypto');

const HEADER_MAGIC = 0x03;
const HEADER_BYTES = 8;
const SUBPROTOCOL = 'remotecontrol';

const ID_TEXT_RESPONSE = 0;
const ID_KEEPALIVE = 6;

// Human-readable identifier names for logging.
const ID_NAMES = {
  0: 'TEXT',
  1: 'BINARY_FILE',
  2: 'VALUE_EVENTS',
  3: 'TEXT_EVENTS',
  4: 'DAYTIMER_EVENTS',
  5: 'OUT_OF_SERVICE',
  6: 'KEEPALIVE',
  7: 'WEATHER_EVENTS',
};

// LOG_RAW_EVENTS=1 dumps a hex preview of every non-TEXT binary payload —
// invaluable for debugging the decoder before it exists. Default off so the
// daemon's normal logs don't drown in megabytes of event data.
const LOG_RAW_EVENTS = process.env.LOG_RAW_EVENTS === '1';
const RAW_EVENT_HEX_BYTES = 256; // preview cap per frame

// 5d.1 hard-codes a generous timeout. Later steps make it configurable.
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

// Activity watchdog — same half-open TCP escape hatch as bridge-client.js,
// applied here because a half-open WSS to the Miniserver doesn't just break
// Alexa control: the daemon never closes the TCP connection on the
// Miniserver's side, leaving a CLOSE_WAIT slot occupied until the Loxone
// stack itself times out (long minutes). Repeated occurrences exhaust the
// embedded socket table, which is the suspected cause of Ethernet-stack
// hangs we've seen on Gen 2 Miniservers. Loxone's own ID_KEEPALIVE cadence
// defaults to ~120s, so 300s leaves plenty of room for quiet periods.
const MS_ACTIVITY_TIMEOUT_MS = Number.parseInt(process.env.MS_MAX_IDLE_MS, 10) || 300_000;
const MS_ACTIVITY_CHECK_MS = 60_000;
const MS_TCP_KEEPALIVE_IDLE_MS = 30_000;

class MiniserverWsClient extends EventEmitter {
  constructor({ msConfig, publicKey, log }) {
    super();
    this.msConfig = msConfig;
    this.publicKey = publicKey;
    this.log = log.child({ component: 'miniserver-ws' });

    this.ws = null;
    this.stopped = false;
    this.aesSession = null;                // {aesKey, aesIv} after keyexchange
    this.salt = null;                      // current hex salt, rotated periodically

    this.pendingHeader = null;             // {identifier, payloadLength}
    // FIFO queue of awaiters. Loxone's flow is strictly sequential
    // (keyexchange → getkey2 → getjwt → enablebinstatusupdate), so we
    // resolve in send-order rather than trying to match by `control` —
    // encrypted commands echo the inner path under one form, plain
    // commands under another, with no robust prefix to predict for both.
    this.responseQueue = [];               // array of {resolve, reject, timer, decryptResponse}

    // Activity watchdog state. lastMessageAt is updated on every inbound
    // frame (keepalive, header, payload); see MS_ACTIVITY_TIMEOUT_MS for
    // the failure mode this guards. openedAt feeds the connection-duration
    // field on the 'closed' log line (forensic for socket-leak analysis).
    this.lastMessageAt = 0;
    this.activityWatchdog = null;
    this.openedAt = 0;
  }

  // Connect, run keyexchange. Resolves once AES session is established
  // (you can then sendCommand for encrypted follow-ups in 5d.2/5d.3).
  async start({ connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    const url = `${this.msConfig.wsBase()}/ws/rfc6455`;
    this.log.info({ url, subprotocol: SUBPROTOCOL }, 'opening miniserver WS');

    // Open the socket. ws library accepts subprotocol as the 2nd arg.
    this.ws = new WebSocket(url, SUBPROTOCOL, {
      rejectUnauthorized: false,           // see miniserver-probe.js for reasoning
      handshakeTimeout: connectTimeoutMs,
      maxPayload: 16 * 1024 * 1024,        // 16 MiB — LoxAPP3.json can be a few MiB
    });

    // Wait for `open`, with a timeout that fires if neither open nor error arrives.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), connectTimeoutMs);
      this.ws.once('open', () => { clearTimeout(timer); resolve(); });
      this.ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    });

    // TCP socket is now open. Record the timestamp for connection-duration
    // logging on close, and enable TCP keepalive — backup for the activity
    // watchdog below (Node's default 2h idle is useless for a control stream).
    this.openedAt = Date.now();
    if (this.ws._socket && typeof this.ws._socket.setKeepAlive === 'function') {
      try {
        this.ws._socket.setKeepAlive(true, MS_TCP_KEEPALIVE_IDLE_MS);
      } catch (err) {
        this.log.debug({ err: err.message }, 'TCP keepalive enable failed (non-fatal)');
      }
    }
    this.log.info({ url }, 'miniserver ws opened');

    // Wire up steady-state handlers.
    this.ws.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
    this.ws.on('close', (code, reason) => this.handleClose(code, reason));
    this.ws.on('error', (err) => this.handleError(err));

    this.log.info('socket open — performing key exchange');
    await this.performKeyExchange();
    this.log.info('key exchange complete; AES session established');

    // Start the activity watchdog only once the full session is up — before
    // key exchange there's no expected inbound traffic cadence to monitor.
    this.startActivityWatchdog();
  }

  async stop({ code = 1000, reason = 'daemon shutdown' } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    this.stopActivityWatchdog();
    // Reject any in-flight commands so callers don't hang.
    while (this.responseQueue.length) {
      const p = this.responseQueue.shift();
      clearTimeout(p.timer);
      p.reject(new Error('miniserver ws stopping'));
    }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try { this.ws.close(code, reason); } catch { /* ignore */ }
    }
  }

  // ----- key exchange -----------------------------------------------------

  async performKeyExchange() {
    const { aesKey, aesIv } = c.generateAesSessionKey();
    const sk = c.rsaEncryptKeyExchange(aesKey, aesIv, this.publicKey);
    // Raw base64 — no URL encoding. The Miniserver doesn't URL-parse WS
    // command frames; everything after "jdev/sys/keyexchange/" up to the
    // end of the frame is the sk. Confirmed against node-lox-ws-api's
    // Token-Enc.js (which sends `... + sessionKey.toString('base64')`
    // verbatim). URL-encoding the '+', '/', '=' chars produces Code=401.
    const cmd = `jdev/sys/keyexchange/${sk}`;

    const response = await this.sendPlainCommand(cmd);
    const code = response?.LL?.Code;
    if (code !== '200' && code !== 200) {
      throw new Error(`keyexchange failed: Code=${code}`);
    }
    this.aesSession = { aesKey, aesIv };
    // Establish an initial salt for the encrypted commands that follow.
    this.salt = c.generateSalt();
    return response;
  }

  // Encrypted command — wraps innerCmd as `salt/<salt>/<innerCmd>`,
  // AES-encrypts, sends via jdev/sys/fenc/<base64>. If encryptResponse is
  // true (default), the Miniserver encrypts the response's `value` field
  // and we decrypt it before resolving.
  async sendEncrypted(innerCmd, { encryptResponse = true, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    if (!this.aesSession) throw new Error('AES session not established (call start() first)');
    const wireCmd = c.buildEncryptedCommand({
      cmd: innerCmd,
      salt: this.salt,
      aesKey: this.aesSession.aesKey,
      aesIv: this.aesSession.aesIv,
      encryptResponse,
    });
    const raw = await this.sendPlainCommand(wireCmd, { timeoutMs, decryptResponse: encryptResponse });
    return raw;
  }

  // ----- command/response correlation (FIFO) -------------------------------

  // Send a plain-text command frame; resolves with the next text response.
  // If decryptResponse is true, the response's LL.value (base64 ciphertext)
  // is AES-decrypted using the current session before resolving — the
  // resulting plaintext is JSON-parsed if possible.
  sendPlainCommand(cmd, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, decryptResponse = false } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.responseQueue.findIndex((q) => q.resolve === resolve);
        if (idx >= 0) this.responseQueue.splice(idx, 1);
        reject(new Error(`command timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.responseQueue.push({ resolve, reject, timer, decryptResponse });
      try {
        this.ws.send(cmd);
      } catch (err) {
        clearTimeout(timer);
        const idx = this.responseQueue.findIndex((q) => q.resolve === resolve);
        if (idx >= 0) this.responseQueue.splice(idx, 1);
        reject(err);
      }
    });
  }

  // ----- inbound message dispatch -----------------------------------------

  handleMessage(data, isBinary) {
    // Watchdog liveness signal: any inbound frame — even a malformed one
    // we'd drop below — proves the bridge → daemon path is still moving
    // bytes. Update before any parsing.
    this.lastMessageAt = Date.now();

    // Loxone protocol invariant:
    //   - 8-byte BINARY frame = header (start of a header/payload pair),
    //     UNLESS we're already expecting a payload (which can be binary
    //     for event tables).
    //   - any frame AFTER a header = its payload.
    if (!this.pendingHeader) {
      if (isBinary && data.length === HEADER_BYTES) {
        this.parseHeader(data);
      } else {
        // Loxone shouldn't send a payload without a preceding header.
        // Log once and drop.
        this.log.warn({ isBinary, len: data.length }, 'payload without header — dropping');
      }
      return;
    }
    // We had a pending header; this frame is its payload.
    const header = this.pendingHeader;
    this.pendingHeader = null;
    this.deliverPayload(header, data, isBinary);
  }

  parseHeader(buf) {
    if (buf[0] !== HEADER_MAGIC) {
      this.log.warn({ first: buf[0] }, 'unexpected first byte in header — dropping');
      return;
    }
    const identifier = buf[1];
    const info = buf[2];
    const estimated = (info & 0x01) === 0x01;
    const payloadLength = buf.readUInt32LE(4);

    if (estimated) {
      // "Estimated" headers are a hint about an upcoming size. The exact
      // header follows immediately. Don't expect a payload.
      this.log.debug({ identifier, payloadLength }, 'skipping estimated header');
      return;
    }
    if (identifier === ID_KEEPALIVE && payloadLength === 0) {
      // Keepalive reply: header-only, no payload follows.
      this.emit('keepalive');
      return;
    }
    this.pendingHeader = { identifier, payloadLength };
  }

  deliverPayload(header, data, isBinary) {
    if (header.identifier === ID_TEXT_RESPONSE) {
      this.deliverTextResponse(data.toString('utf8'));
      return;
    }
    // Binary event payload — emit for the decoder (step 5e), optionally
    // Hex-dump for debugging. Only fires when LOG_RAW_EVENTS=1 is explicitly
    // set in the env — these dumps are too verbose to enable as a side effect
    // of LOG_LEVEL=debug (would flood the log with every state-tick frame).
    // The non-LOG_RAW_EVENTS path used to log a one-liner at debug level for
    // each frame; that was just spam (no actionable info — duplicates of what
    // the higher-level state-cache / event-decode path already reveals).
    if (LOG_RAW_EVENTS) {
      const name = ID_NAMES[header.identifier] || `UNKNOWN(${header.identifier})`;
      const preview = data.subarray(0, RAW_EVENT_HEX_BYTES).toString('hex');
      const truncated = data.length > RAW_EVENT_HEX_BYTES ? ` ...(+${data.length - RAW_EVENT_HEX_BYTES} bytes)` : '';
      this.log.info(
        { id: header.identifier, name, length: data.length, hex: preview + truncated },
        'raw event frame',
      );
    }
    this.emit('binary-payload', { identifier: header.identifier, data });
  }

  // Subscribe to binary status updates. After this resolves with Code 200,
  // the Miniserver pushes the initial state dump (Value-Events + Text-Events
  // + maybe Daytimer + Weather) and then incremental events on state changes.
  // Fire-and-forget response (no encrypted payload to decrypt — the reply is
  // a small Code-200 ack).
  async subscribeBinaryEvents() {
    if (!this.aesSession) throw new Error('subscribeBinaryEvents: WS not authenticated yet');
    const response = await this.sendEncrypted('jdev/sps/enablebinstatusupdate', { encryptResponse: false });
    const code = response?.LL?.Code;
    if (code !== '200' && code !== 200) {
      throw new Error(`enablebinstatusupdate failed: Code=${code}`);
    }
    this.log.info('subscribed to binary status events');
    return response;
  }

  deliverTextResponse(text) {
    // Peek the head awaiter — if it expects an encrypted response (fenc),
    // the WHOLE text frame is base64-encoded AES ciphertext of the LL JSON,
    // not the JSON itself. Decrypt before parsing.
    //
    // We don't shift yet because we want to leave the queue intact if
    // dispatch turns out not to apply (unsolicited messages with no awaiter).
    const head = this.responseQueue[0];
    let effectiveText = text;
    if (head && head.decryptResponse) {
      try {
        const ct = Buffer.from(text, 'base64');
        effectiveText = c.aesDecrypt(ct, this.aesSession.aesKey, this.aesSession.aesIv);
      } catch (err) {
        this.log.warn({ err: err.message, snippet: text.slice(0, 80) }, 'response decrypt failed — trying plaintext');
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(effectiveText);
    } catch (err) {
      this.log.warn(
        { err: err.message, snippet: effectiveText.slice(0, 200), wasDecrypted: head?.decryptResponse === true },
        'failed to parse response as JSON',
      );
      return;
    }

    // Some Miniserver messages (e.g. "Auth" status pings after keyexchange)
    // arrive unsolicited with no LL wrapper. They aren't responses to anything
    // we asked for — leave them on the floor.
    if (!parsed?.LL) {
      this.log.debug({ snippet: effectiveText.slice(0, 80) }, 'non-LL message — ignored');
      return;
    }

    // Normalise Loxone's case-inconsistent Code field. Plaintext responses
    // (e.g. keyexchange) ship as `LL.Code`; encrypted responses unwrap to
    // `LL.code`. Make callers' lives easier by exposing both.
    if (parsed.LL.code !== undefined && parsed.LL.Code === undefined) parsed.LL.Code = parsed.LL.code;
    if (parsed.LL.Code !== undefined && parsed.LL.code === undefined) parsed.LL.code = parsed.LL.Code;

    const awaiter = this.responseQueue.shift();
    if (!awaiter) {
      this.log.debug({ control: parsed.LL.control }, 'response had no awaiter');
      return;
    }
    clearTimeout(awaiter.timer);
    awaiter.resolve(parsed);
  }

  handleClose(code, reasonBuf) {
    const reason = reasonBuf ? reasonBuf.toString() : '';
    this.stopActivityWatchdog();
    // wasOpenForMs is for forensics on socket-leak / reconnect-storm
    // analysis — quickly tells you if a connection died young (TCP error)
    // versus expired naturally (e.g. token timeout, network blip).
    const wasOpenForMs = this.openedAt ? Date.now() - this.openedAt : null;
    this.log.info({ code, reason, wasOpenForMs }, 'miniserver ws closed');
    while (this.responseQueue.length) {
      const p = this.responseQueue.shift();
      clearTimeout(p.timer);
      p.reject(new Error(`socket closed (${code}) before response`));
    }
    this.ws = null;
    this.emit('close', { code, reason });
  }

  handleError(err) {
    this.log.warn({ err: err.message }, 'miniserver ws error');
    this.emit('error', err);
  }

  // Half-open TCP escape hatch. The Miniserver sends ID_KEEPALIVE roughly
  // every ~120s when idle; if MS_ACTIVITY_TIMEOUT_MS elapses with no
  // inbound frames at all, the underlying TCP path is presumed dead. We
  // use terminate() (not close()) so we don't wait on a close handshake
  // the dead peer can't complete — that handshake-on-dead-path is the
  // exact failure mode that leaves CLOSE_WAIT slots on the Miniserver.
  startActivityWatchdog() {
    if (this.activityWatchdog) return;
    this.lastMessageAt = Date.now();
    this.activityWatchdog = setInterval(() => {
      const idleMs = Date.now() - this.lastMessageAt;
      if (idleMs > MS_ACTIVITY_TIMEOUT_MS) {
        this.log.warn(
          { idleMs, timeoutMs: MS_ACTIVITY_TIMEOUT_MS },
          'no inbound traffic from miniserver — terminating dead socket (half-open?)',
        );
        try { if (this.ws) this.ws.terminate(); } catch { /* ignore */ }
      }
    }, MS_ACTIVITY_CHECK_MS);
    if (typeof this.activityWatchdog.unref === 'function') {
      this.activityWatchdog.unref();
    }
  }

  stopActivityWatchdog() {
    if (this.activityWatchdog) {
      clearInterval(this.activityWatchdog);
      this.activityWatchdog = null;
    }
  }
}

module.exports = { MiniserverWsClient };
