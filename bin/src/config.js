'use strict';

// Daemon configuration loaded once at boot from environment variables.
//
// On a real LoxBerry install these are populated by the start wrapper
// (cron.reboot → aloxberry-control.sh → systemd-ish supervision) from
// the plugin's config file. For local development, set them in your
// shell or a .env loader before invoking `node src/index.js`.
//
// Missing required vars → log a fatal-level message and exit(2). We
// deliberately fail loud rather than try to "do something sensible";
// a daemon that boots with wrong config is worse than one that doesn't
// boot at all, because it will silently mis-route directives.

const path = require('node:path');

const REQUIRED = ['BRIDGE_URL'];

function loadConfig() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (missing.length > 0) {
    // Log via plain stderr — the daemon logger isn't initialised yet.
    process.stderr.write(
      `${new Date().toISOString()} [CRIT ] missing required env vars `
      + `missing=${JSON.stringify(missing)}\n`,
    );
    process.exit(2);
  }

  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(__dirname, '..', '..', 'data');

  // configDir holds anything that should SURVIVE plugin upgrades — identity
  // files, daemon.env, devices.json. Install-time mapping: $LBPCONFIG/<plugin>
  // (LoxBerry preserves $LBPCONFIG across upgrades; $LBPBIN is wiped).
  const configDir = process.env.CONFIG_DIR
    ? path.resolve(process.env.CONFIG_DIR)
    : path.resolve(__dirname, '..', '..', 'config');

  // The identity dir is a subdir of configDir by default. It can be
  // overridden via IDENTITY_DIR for unusual layouts.
  const identityDir = process.env.IDENTITY_DIR
    ? path.resolve(process.env.IDENTITY_DIR)
    : path.join(configDir, 'identity');

  return Object.freeze({
    // --- bridge --------------------------------------------------------
    // Public URL of the dispatch bridge. WSS upgrade happens against
    // `${BRIDGE_URL}/connect`. Example: https://bridge.example.com:8443
    bridgeUrl: process.env.BRIDGE_URL,

    // --- runtime -------------------------------------------------------
    // Log level — accepts either:
    //   - LoxBerry numeric 0-7 (control.sh exports this from the per-plugin
    //     level set in LoxBerry's Logs-tab dropdown — the canonical path);
    //   - a level name (LoxBerry or pino), for standalone/dev runs.
    // See bin/src/log.js for the full mapping.
    logLevel: process.env.LOG_LEVEL || 'info',

    // Where state.json, config.json, and command files live. Defaults to
    // <repo>/data when running from a checkout; the install scripts will
    // set DATA_DIR to REPLACELBPDATADIR (the LoxBerry per-plugin data dir,
    // usually on the ramdisk to bound flash wear).
    dataDir,

    // $LBPCONFIG/<plugin> equivalent. Survives plugin upgrades.
    // Holds: daemon.env, devices.json, identity/ subdir.
    configDir,

    // Where userId + skillSecret persist. Subdir of configDir by default.
    identityDir,

    // --- local HTTP API (CGI control surface) --------------------------
    // Loopback-only. The LoxBerry's CGI runs on the same box, so 127.0.0.1
    // is the only address that needs to reach this server. Externally
    // it's TLS-terminated and proxied by the user's Caddy/nginx if at all.
    localHttpPort: Number.parseInt(process.env.LOCAL_HTTP_PORT, 10) || 7800,

    // --- tunables ------------------------------------------------------
    // Reconnect backoff (ms). Caps after a few doublings.
    reconnectInitialMs: Number.parseInt(process.env.RECONNECT_INITIAL_MS, 10) || 1000,
    reconnectMaxMs: Number.parseInt(process.env.RECONNECT_MAX_MS, 10) || 60000,

    // App-layer ping cadence — keep slightly below the bridge's
    // HEARTBEAT_INTERVAL_MS (default 30s on the bridge side).
    heartbeatIntervalMs: Number.parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10) || 25000,
  });
}

module.exports = { loadConfig };
