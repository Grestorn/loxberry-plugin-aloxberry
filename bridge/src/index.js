'use strict';

// Aloxberry bridge — entry point.
//
// One process, one HTTP server. The HTTP server handles /health, /dispatch,
// /probe over plain HTTP, and routes WebSocket upgrades on /connect to the
// `ws` library's WebSocketServer running in `noServer: true` mode (so we
// keep upgrade routing in our own hands instead of letting `ws` blanket-
// accept every Upgrade request on the listener).
//
// Step 1 scaffold: boots, listens, serves /health, returns 501 for the
// stub HTTP routes, accepts /connect upgrades and immediately closes them.
// Real protocol logic lands in subsequent steps.

const http = require('http');
const { WebSocketServer } = require('ws');
const pino = require('pino');

const httpHandlers = require('./http-handlers');
const wsHandlers = require('./ws-handlers');

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
});

const PORT = Number.parseInt(process.env.PORT, 10) || 8080;
const BRIDGE_DISPATCH_SECRET = process.env.BRIDGE_DISPATCH_SECRET || '';

// Connection caps (P0 #5 hardening): the bridge is publicly reachable, so
// an unauthenticated client can otherwise open sockets without limit and
// exhaust memory/FDs for every real user. Generous defaults — well above
// any realistic legitimate fan-out — so they only ever bite abuse. The
// global cap is the real backstop; the per-IP cap is intentionally loose
// because behind a reverse proxy (Caddy) the client key may collapse to a
// few values. Both env-overridable.
const MAX_CONNECTIONS =
  Number.parseInt(process.env.MAX_CONNECTIONS, 10) || 5000;
const MAX_CONNECTIONS_PER_IP =
  Number.parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 50;

let totalConns = 0;
const connsByIp = new Map();

// Best-effort client key: first X-Forwarded-For hop when present (we sit
// behind Caddy/TLS termination), else the raw socket peer.
function clientKey(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',', 1)[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

if (!BRIDGE_DISPATCH_SECRET) {
  // Allow boot without it so `npm start` for local scaffold testing works,
  // but make it loud — step 3 will reject /dispatch when this is missing.
  log.warn('BRIDGE_DISPATCH_SECRET is unset; /dispatch will reject every request once implemented');
}

const server = http.createServer((req, res) => {
  httpHandlers.handleRequest(req, res, log);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = req.url.split('?', 1)[0];
  if (path !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const ip = clientKey(req);
  const ipCount = connsByIp.get(ip) || 0;
  if (totalConns >= MAX_CONNECTIONS || ipCount >= MAX_CONNECTIONS_PER_IP) {
    log.warn({ totalConns, ipCount, atGlobalCap: totalConns >= MAX_CONNECTIONS },
      'connection cap reached — refusing upgrade');
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  totalConns += 1;
  connsByIp.set(ip, ipCount + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    totalConns -= 1;
    const n = (connsByIp.get(ip) || 1) - 1;
    if (n <= 0) connsByIp.delete(ip);
    else connsByIp.set(ip, n);
  };
  // If the upgrade itself fails the ws 'close' never fires — release on the
  // raw socket close too (idempotent via the `released` guard).
  socket.on('close', release);
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.once('close', release);
    wsHandlers.handleConnection(ws, req, log);
  });
});

server.listen(PORT, () => {
  log.info({ port: PORT }, 'bridge listening');
});

function shutdown(signal) {
  log.info({ signal }, 'shutdown requested');
  server.close(() => {
    log.info('http server closed');
    process.exit(0);
  });
  // Hard-exit fallback if connections refuse to drain.
  setTimeout(() => {
    log.warn('forced exit after 5s drain timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
