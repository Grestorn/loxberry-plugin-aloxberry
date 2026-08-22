# Changelog

All notable changes to Aloxberry are listed here. This is a **curated** log:
new features and changes that affect how the plugin behaves for you. Routine
version bumps, internal refactors, developer tooling, documentation-only edits
and small cosmetic fixes are deliberately left out — the git history has those.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
across the four release artifacts (plugin, daemon, bridge, AWS Lambdas).

---

## [Unreleased]

### Added
- **Gates can be exposed as voice-code-protected garage doors.** A Loxone
  `Gate` now has two renderings, chosen by its Alexa category. The default
  (`DOOR`) is unchanged. The new opt-in (`GARAGE_DOOR`) declares the device in
  the form Amazon recognises as a garage door, which makes **Alexa ask for a
  spoken security code before opening** — closing is never challenged. The code
  is set per device in the Alexa app and checked in Amazon's cloud; the plugin,
  the bridge and the Lambda never see it. Picking the category flips the
  capability for you, and vice versa.

  Trade-offs, both surfaced in the picker: the garage-door rendering has no
  partial positions, and Amazon supports it only in `de-DE`, `en-GB`, `en-US`,
  `es-ES`, `es-US`, `fr-FR` and `it-IT` — **not** `nl-NL`. This reverses the
  removal of `GARAGE_DOOR` in 0.7.1, which had dropped it for lack of exactly
  this implementation. Gates carried over from an installation older than
  0.7.1 keep working exactly as before — they are **not** silently converted,
  so nobody's gate starts demanding a code they never set.
- **Voice-code reminder on the account-linking page**, in all six languages,
  as Amazon's security requirements ask for.
- **New user documentation chapter: Gates & garage doors** (`gates.md`, English
  and German) — the two options side by side, how to set the code up, what you
  give up, and what the code does *not* cover.

## [1.3.0] — 2026-08-21

### Fixed
- **Controls deleted in Loxone Config no longer come back in Alexa.** The
  device row was still included in every discovery response, so Alexa re-added
  the device each time it re-discovered — deleting it in the Alexa app only
  helped until the next discovery. Such "orphans" are now skipped when talking
  to Alexa, while the row itself is deliberately **kept** in the plugin (you
  picked that device, so only you remove it — and repairing the control in
  Loxone Config makes it valid again). Orphans are always listed in the
  *Devices* tab, marked, and never hidden by a filter.
- **"Refresh catalogue" now applies immediately** instead of waiting for a save
  or a daemon restart.

## [1.2.2] — 2026-07-31

### Changed
- **Proactive state reports are rate-limited.** The daemon was sending roughly
  118,000 state reports a day across all paired users — almost none carrying
  new information, because free-running analog sensors emit raw float changes
  that collapse to the same value once Alexa rounds them. Two mechanisms now
  compare *the value Alexa actually receives*: duplicate suppression (always
  on, lossless — Alexa already holds that value) and a 30-second minimum
  interval for analog sensors only. The interval **defers** rather than drops,
  so a reading is never lost, and temperature is quantised to 0.1 °C — finer
  than Alexa displays. Tunable via `ALOXBERRY_SENSOR_MIN_INTERVAL_MS`
  (`0` disables).

## [1.2.1-rc] — 2026-06-28

### Added
- **"Open", "close", "raise" and "lower" now work for blinds, windows and
  gates.** They were previously advertised to Alexa with percentages and
  presets only, so classic (non-LLM) Alexa had no way to turn a bare verb into
  a command — "set it to 100" worked, "open it" did not. Alexa localises the
  verbs itself (German "öffnen/schließen/auf/zu", French "ouvre/ferme", …);
  nothing to configure. **Say "Alexa, discover devices" after upgrading** —
  an already-known blind keeps responding to percentages only until you do.
- **Presence & person detection guide.** How to use an Echo's own occupancy
  and Visual ID detection as an Alexa Routine trigger that drives a Loxone
  Virtual Input — no plugin changes needed. New `presence.md` (English and
  German).
- Documentation of how a Loxone **Lighting Controller** publishes each light
  channel plus a "Master" switch as separately pickable devices.

## [1.2.0] — 2026-06-21

### Added
- **Timed switches can now actually use the Loxone timer.** A Loxone staircase
  or comfort switch was mapped to a permanent on, so the block's timer never
  ran. Two new options: keep it a switch and tick **Trigger timer / Toggle with
  timer** so "Alexa, turn on" fires the timed pulse; or expose it as an Alexa
  **Scene**, which is stateless and therefore re-triggerable as often as you
  like (a switch Alexa believes is already on cannot be re-fired). The wording
  follows the Loxone mode — staircase light vs. comfort switch.
- **The picker keeps capability and category in step.** Choosing a scene
  category selects the Scene capability and vice versa, so combinations that
  cannot work are no longer reachable. Also applied to the sensor types
  (temperature/humidity, contact/motion).

## [1.1.1] — 2026-06-19

### Fixed
- **A rejected Miniserver token no longer wedges the connection permanently.**
  When the cached token was refused, re-authentication was attempted on the
  same socket the Miniserver had just closed, so it failed too and the stale
  token was never discarded — every cycle then failed identically
  ("Abfrage fehlgeschlagen") until a restart. A rejected token is now dropped
  and re-authentication runs on a fresh connection, bounded to one retry so a
  genuinely wrong password fails cleanly with a visible reason.

## [1.1.0] — 2026-06-14

### Added
- **Polling mode: an alternative to the permanent Miniserver connection.**
  Gen 2 Miniservers have crashed their embedded network stack under a
  long-lived WebSocket even with keepalive and watchdogs in place. In poll mode
  the daemon holds **no permanent connection**: once per interval it connects,
  authenticates, pulls the full state table, and disconnects. Status still
  flows to Alexa, with up to one interval of latency. Opt-in per installation
  in the plugin's settings; live mode remains the default.

## [1.0.0] — 2026-06-06

First official release. No functional changes over `0.7.3`; this version
promotes the existing codebase to a stable `1.0.0` milestone.

## [0.7.3] — 2026-06-04

### Added
- **Room humidity from the Intelligent Room Controller (V2)** can be exposed as
  a humidity sensor — an opt-in checkbox, shown only when the controller
  actually has a humidity input wired, so there is never a dead option.

### Fixed
- **Thermostat temperatures were mis-reported as Fahrenheit.** The `f` in
  Loxone's `%.1f°` float format was read as a Fahrenheit marker, so 24.3 °C
  reached Alexa as -4.5°. Affected every temperature reading: thermostat, AC,
  ventilation and analog status values.
- **Fresh installs no longer advertise a "Plugin Test" switch.** An empty
  configuration fell back to a built-in test fixture, exposing a device nobody
  selected. An empty configuration now exposes nothing.

## [0.7.2] — 2026-05-31

### Fixed
- **Loxone scenes now actually fire.** The activate command was sent as
  `Pulse`; the Miniserver silently accepted it, reported success, and did
  nothing. It is now sent as lowercase `pulse`, as Loxone requires.

## [0.7.1] — 2026-05-28

### Added
- **Dutch (`nl`)**, completing the language set: the web UI, the OAuth pages
  and the Alexa device synonyms now ship in `en`, `de`, `fr`, `it`, `es`, `nl`.
- **Active keepalive probe on the Miniserver connection** — a dead socket is
  detected and replaced within ~35 s instead of waiting five minutes on the
  passive idle watchdog.

### Removed
- **`GARAGE_DOOR`, `DOORBELL` and `CAMERA` categories**, which needed Alexa
  interfaces the plugin did not implement. Existing entries are migrated
  automatically to the control type's default on the next daemon start.
  *(`GARAGE_DOOR` returns, properly implemented, in the Unreleased section
  above.)*

## [0.7.0] — 2026-05-26

### Added
- **Spanish, German, French and Italian** translations of the web UI and the
  account-linking flow.

### Fixed
- **The daemon retries a failed start-up** instead of giving up and requiring a
  manual restart — no more losing the boot race against slow DNS or a
  still-booting Miniserver.

## [0.6.7] — 2026-05-23

### Changed
- Dropped the obsolete "restart required" hint after a log-level change; live
  re-reading landed in 0.6.5.

## [0.6.6] — 2026-05-23

### Added
- **Connection indicators** in the web UI for both the Miniserver and the cloud
  bridge, plus a button to delete dead pairings.
- **Inline help** across the configuration pages, and a **Tips & How-Tos**
  chapter in the user documentation.

### Fixed
- **Alexa links were dying silently.** Two independent causes: Amazon's refresh
  tokens were being rotated, which killed the link once Amazon's grace window
  passed; and the token lookup read only a single record, which broke *every*
  established link as soon as more than one user existed.
- **A half-open connection to the bridge is now detected automatically.** The
  daemon believed the socket was open while nothing was flowing through it;
  only a restart cured it. A watchdog now does that on its own.

## [0.6.5] — 2026-05-19

### Added
- **Log-level changes take effect without restarting the daemon.**

### Changed
- **Audioserver (`AudioZoneV2`) zones no longer offer a favorites picker.** The
  Miniserver does not publish the favorite list for them (Loxone documents that
  API as not publicly available), so the picker would only ever have shown
  meaningless "Source 1–8" entries. The older MusicServer (`AudioZone`) keeps
  its working favorites. A tested workaround using a Loxone Radio block is
  documented in the Tips chapter.

## [0.6.4] — 2026-05-18

### Fixed
- **Plugin install failed on the empty `config/` directory** — LoxBerry strips
  dotfiles during unpack, so a `.gitkeep`-only directory arrived empty and
  broke the install.
- **Individual light channels of a Lighting Controller now work.** The parent
  block responded, its sub-controls returned errors.

## [0.6.2] — 2026-05-17

### Changed
- **Lowered the Node.js requirement to 18** (from 20), matching what current
  LoxBerry images ship. *(0.6.3 followed with packaging corrections: the
  LoxBerry minimum-version declaration and post-rebrand icon names.)*

## [0.6.1] — 2026-05-17

The Aloxberry rebrand baseline. Plugin, daemon, bridge and AWS Lambdas were all
republished under the new name; releases 0.1.0 – 0.6.0 existed under the prior
"loxhome" identity.

### Added
- **Privacy Policy and Terms of Use** pages, required for Alexa skill
  certification.

### Changed
- Project renamed from "loxhome" to **Aloxberry**. The `loxhome-bridge.net` /
  `.com` DNS names are deliberately retained so any pre-rebrand client traffic
  keeps working — they are not stale and should not be "fixed".

---

## [0.1.0] — pre-rebrand

Initial repository scaffold (LoxBerry plugin layout plus the AWS skeleton).
Detailed history for 0.1.0 through 0.6.0 lived in the pre-rebrand "loxhome"
repository and is not reflected here.

[Unreleased]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/1.3.0...HEAD
[1.3.0]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/1.2.2...1.3.0
[1.2.2]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/1.2.1-rc...1.2.2
[1.2.1-rc]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/1.2.0...1.2.1-rc
[1.2.0]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/1.1.1...1.2.0
[1.1.1]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/1.1.0...1.1.1
[1.1.0]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/1.0.0...1.1.0
[1.0.0]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.7.3...1.0.0
[0.7.3]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.7.2...0.7.3
[0.7.2]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.7.1...0.7.2
[0.7.1]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.7.0...0.7.1
[0.7.0]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.7...0.7.0
[0.6.7]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.6...0.6.7
[0.6.6]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.5...0.6.6
[0.6.5]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.4...0.6.5
[0.6.4]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.3...0.6.4
[0.6.2]: https://github.com/Grestorn/loxberry-plugin-aloxberry/compare/0.6.1...0.6.2
[0.6.1]: https://github.com/Grestorn/loxberry-plugin-aloxberry/releases/tag/0.6.1
