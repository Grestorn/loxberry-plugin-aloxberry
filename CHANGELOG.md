# Changelog

All notable changes to Aloxberry are listed here. Only user-facing or
operationally significant changes are included; routine release bumps,
internal refactors, and planning docs are omitted.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
across the four release artifacts (plugin, daemon, bridge, AWS Lambdas).

---

## [0.7.1] — 2026-05-28

### Added
- **Active keepalive probe on the Miniserver WebSocket.** Sends a `keepalive`
  command every 30 s with a 5 s reply deadline; force-terminates the socket
  on failure so the Miniserver-side TCP slot is freed within ~35 s instead
  of waiting on the 5-minute passive idle watchdog. Targets suspected
  half-open TCP accumulation behind intermittent Gen 2 Miniserver Ethernet
  stack hangs. Tunables: `MS_KEEPALIVE_MS`, `LOG_KEEPALIVE`.
- **Dutch (`nl`) localization** added; full translations now ship for `en`,
  `de`, `fr`, `it`, `es`, `nl` across the web UI, OAuth pages, and Discovery
  device synonyms.

### Changed
- Localized text uses proper typographic quotes per language
  (German „…", French « … », etc.) instead of straight ASCII quotes.

### Removed
- **`GARAGE_DOOR`, `DOORBELL`, and `CAMERA` device types removed** —
  they did not map cleanly to Loxone controls. Existing `devices.json`
  entries of these types are silently dropped on first daemon start
  after upgrade. Re-expose affected controls as switches or scenes.

## [0.7.0] — 2026-05-26

### Added
- Initial **`es`, `de`, `fr`, `it` localizations** for the web UI and
  OAuth flow.

### Fixed
- **Daemon bootstrap retries transient network failures** when fetching
  the Miniserver structure on startup, instead of crashing and requiring
  manual restart. Eliminates the boot-time race against slow DNS or a
  still-booting Miniserver.

### Changed
- `ddb-list` operator script reports per-bridge LWA-revoked status and a
  summary line.

## [0.6.7] — 2026-05-23

### Changed
- Removed the obsolete "restart required" hint shown after changing the
  LoxBerry log level (live re-read landed in 0.6.5).

## [0.6.6] — 2026-05-23

### Added
- **Connection indicators in the web UI** for both the Miniserver and
  cloud-bridge legs, plus a button to delete dead pairings.
- **Inline help** across the configuration pages.
- **Tips & How-Tos** chapter in the user documentation (light moods,
  audio favorites workaround).

### Fixed
- **Hardened Miniserver connection against socket exhaustion** —
  reconnect floor raised when the Miniserver returns HTTP 503 so
  aggressive retries don't make the situation worse.
- **Activity watchdog on the bridge WebSocket** catches half-open WSS
  to the cloud bridge (daemon thought the socket was OPEN while no
  bytes were flowing — restart cured it; the watchdog now does the same
  automatically).
- **OAuth refresh-token lookup paginated** — previously a hardcoded
  Scan Limit of 1 broke every established Alexa link as soon as more
  than one user existed.
- **Stopped rotating Amazon refresh tokens** — rotation was causing
  silent link death after Amazon's grace window expired. Heartbeat log
  line added so the OAuth handler's idle state is observable.
- Devices page no longer renders a dangling arrow when a parent control
  name is missing.

## [0.6.5] — 2026-05-19

### Added
- **Daemon picks up LoxBerry log-level changes without a restart** —
  the level dial in the LoxBerry Logs tab takes effect on the next
  log line.

### Changed
- AudioZoneV2 capability rework: source picker restricted to V1
  AudioZone (the V2 Audioserver has no favorites API). Documented
  the workaround for using Radio favorites with V2.

## [0.6.4] — 2026-05-18

### Fixed
- **Plugin install no longer fails on empty `config/` directory.**
  LoxBerry strips dotfiles during unpack, so a `.gitkeep`-only directory
  came out empty and broke `cp`. Replaced with a non-dotfile placeholder.
- **LightControllerV2 sub-controls** ("Lichtgruppen", e.g. `AI2`,
  `masterValue`) now accepted by `lox-control.pl` — previously the
  parent block worked but sub-controls returned errors.

### Changed
- Bridge `PAIR_TTL_MS` exposed via compose env and documented for
  operators running the bridge themselves.

## [0.6.3] — 2026-05-18

### Fixed
- Corrected the LoxBerry minimum-version requirement in `plugin.cfg`
  so the plugin manager doesn't block install on supported LoxBerry
  releases.
- Plugin name in icon filenames corrected to match the post-rebrand
  identifier.

## [0.6.2] — 2026-05-17

### Changed
- **Lowered required Node.js version to 18** (was 20) — extends
  compatibility to the Node version shipped with current LoxBerry
  base images. Stale references to the pre-rebrand plugin name
  cleaned up.

## [0.6.1] — 2026-05-17

The Aloxberry rebrand baseline. Plugin, daemon, bridge, and AWS Lambdas
all republished under the new name; previous releases (0.1.0 – 0.6.0)
existed under the prior "loxhome" identity.

### Added
- **Privacy Policy and Terms of Use** pages (required for Amazon
  Alexa skill certification).
- Bridge pair-code TTL exposed via `PAIR_TTL_MS` for cert-review
  scenarios that need an extended window.

### Changed
- Project renamed from "loxhome" to "Aloxberry". The `loxhome-bridge.net`
  / `.com` DNS names are deliberately retained for backwards-compat with
  any pre-rebrand client traffic — they are not stale and should not be
  "fixed".

---

## [0.1.0] — pre-rebrand

Initial repository scaffold (LoxBerry plugin layout + AWS subfolder
skeleton). Detailed history for 0.1.0 through 0.6.0 lived in the
pre-rebrand "loxhome" repository and is not reflected in this
changelog.

[0.7.1]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.7.0...0.7.1
[0.7.0]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.7...0.7.0
[0.6.7]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.6...0.6.7
[0.6.6]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.5...0.6.6
[0.6.5]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.4...0.6.5
[0.6.4]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.3...0.6.4
[0.6.3]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.2...0.6.3
[0.6.2]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.1...0.6.2
[0.6.1]: https://github.com/Grestorn/loxberry-plugin-aloxberry/releases/tag/0.6.1
