# Aloxberry — Alexa Smart Home plugin for Loxone

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENCE)
[![LoxBerry](https://img.shields.io/badge/LoxBerry-%3E%3D1.4.3-green.svg)](https://www.loxwiki.eu/display/LOXBERRY/LoxBerry)

> ⚠️ **Public beta (v0.5.0).** This is a public beta release intended for a
> limited circle of friendly‑user testers. Expect rough edges, breaking
> changes between versions, and occasional re‑linking. Please report issues.

Open‑source Amazon Alexa Smart Home integration for the **Loxone** home
automation system, running as a **LoxBerry** plugin.

Control your Loxone home by voice — *"Alexa, turn off the living‑room lights"*,
*"Alexa, set the bedroom to 21 degrees"* — while keeping control: you choose
exactly which Loxone components Alexa can see, your LoxBerry is never exposed to
the internet, and the cloud relay can neither read nor forge your commands.

A single shared, free, open‑source cloud backend serves many independent
LoxBerry installations; users only install this plugin and link the "Aloxberry"
skill. The cloud parts are also self‑hostable.

```mermaid
flowchart LR
    A["🗣️ Alexa"] --> L["☁️ AWS Lambda"]
    L --> B["🔁 Bridge (blind relay)"]
    B --> P["🏠 LoxBerry plugin"]
    P --> M["⚙️ Loxone Miniserver"]
```

## Documentation

| Audience | Start here |
|----------|-----------|
| 👤 **Users** (English) | [`doc/user/en/README.md`](doc/user/en/README.md) — purpose, security, setup, full Loxone↔Alexa device mapping |
| 👤 **Anwender** (Deutsch) | [`doc/user/de/README.md`](doc/user/de/README.md) |
| 🛠️ **Developers / self‑hosters** | [`doc/dev/README.md`](doc/dev/README.md) — architecture, components, bridge & AWS backend, security model, design decisions |

## At a glance

- **Requirement:** a LoxBerry ≥ 1.4.3 (3.x recommended) with a configured
  Loxone Miniserver. Nothing else — no port forwarding, no public IP.
- **Safety:** opt‑in per device, end‑to‑end HMAC (blind bridge), no inbound
  exposure, Loxone credentials never leave the LoxBerry, prominent kill
  switches. See [`doc/user/en/security.md`](doc/user/en/security.md).
- **Self‑hosting:** run your own bridge and/or AWS backend — see
  [`doc/dev/`](doc/dev/README.md).

## Repository layout

```
.
├── plugin.cfg               # LoxBerry plugin manifest (plugin root)
├── bin/                     # Plugin daemon (Node.js) + Loxone Perl helpers
├── webfrontend/htmlauth/    # Plugin config UI (Perl CGI, authenticated)
├── templates/               # HTML::Template views + lang/ translations
├── cron/, config/, icons/   # Standard LoxBerry plugin dirs
├── uninstall/               # LoxBerry uninstall hook
│
├── bridge/                  # Dispatch bridge (NOT shipped with the plugin)
├── aws/                     # AWS Lambda backend + SAM (NOT shipped)
│
├── doc/                     # User + developer documentation
└── plan/                    # Design documents and implementation roadmap
```

`bridge/` and `aws/` live in this monorepo for development convenience but are
outside LoxBerry‑recognised plugin paths, so the installer ignores them.

## License

Apache License 2.0 — see [`LICENCE`](LICENCE).

Copyright © 2026 Martin Korndörfer
