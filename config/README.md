# config/

This directory is part of LoxBerry's plugin layout. At install time it is
mapped to the plugin's persistent config location:

```
$LBPCONFIG/<plugin>      e.g. /opt/loxberry/config/plugins/alexa-aloxberry/
```

LoxBerry preserves this directory across plugin upgrades (unlike the daemon's
`bin/` tree, which is wiped and re-unpacked on every upgrade).

## What lives here at runtime

`postinstall.sh` creates these on first install; they are **not** shipped in
the plugin archive (they are generated per-installation and contain
host-specific or secret data):

- `daemon.env`      — non-secret runtime config (port, log level, bridge URL)
- `devices.json`    — the user's picked Alexa devices
- `identity/`       — `userId` + `skillSecret` (mode 700; never leaves the Pi)

## Why this README exists (do not delete)

Git cannot track an empty directory, so the directory needs a marker file.
`.gitkeep` covers the Git side — but LoxBerry's plugin installer **strips
dotfiles** during unpack for security. If `.gitkeep` were the *only* file
here, LoxBerry would unpack an empty `config/` and emit a non-fatal
"config folder is empty" install warning that confuses users.

This `README.md` is a non-dotfile, so it survives the dotfile stripping and
the installed `config/` is non-empty. Keep both files until real shipped
config content exists. See the matching note in `create-plugin-zip.sh`
(the same trap previously hit `webfrontend/htmlauth/.gitkeep`).
