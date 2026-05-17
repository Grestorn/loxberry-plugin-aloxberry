#!/bin/bash
#
# Runs AFTER LoxBerry has unpacked the plugin files into place.
# Runs as the `loxberry` user. /etc/environment env vars are available.
#
# Exit codes: 0 = ok, 1 = warning (install continues), 2 = fatal (install cancelled).

COMMAND=$0
PTEMPDIR=$1
PSHNAME=$2
PDIR=$3       # plugin folder name, e.g. "alexa-aloxberry"
PVERSION=$4
PTEMPPATH=$6

PBIN=$LBPBIN/$PDIR
PDATA=$LBPDATA/$PDIR
PCONFIG=$LBPCONFIG/$PDIR
PLOGS=$LBPLOG/$PDIR   # ramdisk — wiped on reboot

# ---- 0. Diagnostic header -------------------------------------------------
echo "<INFO> Alexa Smart Home: POSTINSTALL — PDIR=$PDIR PVERSION=$PVERSION PTEMPPATH=$PTEMPPATH"
echo "<INFO> Alexa Smart Home: POSTINSTALL — PBIN=$PBIN PCONFIG=$PCONFIG PDATA=$PDATA"
if [ -f "$PTEMPPATH/_daemon_was_running" ]; then
    echo "<INFO> Alexa Smart Home: POSTINSTALL — upgrade context detected (marker present)"
else
    echo "<INFO> Alexa Smart Home: POSTINSTALL — fresh install context (no marker)"
fi

# Log state of $PCONFIG on entry — tells us whether LoxBerry's unpack
# preserved or wiped it. If wiped during upgrade, postupgrade.sh restore
# is doing the heavy lifting.
echo "<INFO> Alexa Smart Home: POSTINSTALL — $PCONFIG on entry:"
if [ -d "$PCONFIG" ]; then
    ls -la "$PCONFIG" 2>&1 | sed 's/^/<INFO>   /'
else
    echo "<INFO>   (directory does not exist yet)"
fi

# ---- 1. Create runtime directories ----------------------------------------
echo "<INFO> Alexa Smart Home: POSTINSTALL — creating data/config/log dirs ..."
mkdir -p "$PDATA"
mkdir -p "$PCONFIG"
mkdir -p "$PCONFIG/identity"
chmod 700 "$PCONFIG/identity"   # holds skillSecret — restrict perms
mkdir -p "$PLOGS"
echo "<OK> Alexa Smart Home: POSTINSTALL — directories ready."

# ---- 2. Install Node.js dependencies for the daemon -----------------------
# The daemon needs Node 24+ (per bin/package.json#engines.node). preinstall.sh
# already verified this; if we're here we can run `npm install` confidently.
echo "<INFO> Alexa Smart Home: Installing Node.js daemon dependencies..."
if [ ! -f "$PBIN/package.json" ]; then
    echo "<ERROR> Alexa Smart Home: $PBIN/package.json missing — bad install state."
    exit 2
fi

cd "$PBIN" || exit 2
# --omit=dev keeps any dev-only deps out of the production install. The
# daemon's logger (bin/src/log.js) has zero runtime deps, so there's
# nothing pretty-printer-shaped to ship.
if ! npm install --omit=dev --no-audit --no-fund --silent 2>&1; then
    echo "<ERROR> Alexa Smart Home: npm install failed."
    exit 2
fi
echo "<OK> Alexa Smart Home: Daemon dependencies installed."

# ---- 3. Default daemon.env (only if it doesn't already exist) --------------
# This file holds runtime config (non-secret). The web UI will eventually
# manage it; for first-install we write a stub the user can edit if they
# don't want to go through the UI immediately.
DAEMON_ENV="$PCONFIG/daemon.env"
if [ ! -f "$DAEMON_ENV" ]; then
    echo "<INFO> Alexa Smart Home: Writing default daemon.env..."
    cat > "$DAEMON_ENV" <<'EOF'
# Aloxberry daemon runtime config.
# Edit via the plugin's web UI, or by hand and `bin/control.sh restart`.
# Lines beginning with # are comments. No secrets belong here — the daemon
# manages its own identity files under $LBPCONFIG/alexa-aloxberry/identity/.
# LOG_LEVEL is NOT in this file: control.sh reads it from LoxBerry's
# per-plugin level (the dropdown on the plugin's Logs tab) at every start.

# Public URL of the Aloxberry dispatch bridge. Required.
BRIDGE_URL=https://loxhome-bridge.net

# Loopback HTTP port the CGI talks to. Change only if 7800 is already taken
# on the LoxBerry by another plugin.
LOCAL_HTTP_PORT=7800
EOF
    chmod 600 "$DAEMON_ENV"
    echo "<OK> Alexa Smart Home: Default config written to $DAEMON_ENV"
else
    echo "<INFO> Alexa Smart Home: Existing daemon.env preserved."
fi

# ---- 4. Make bin scripts executable ----------------------------------------
# The .lbplugin zip preserves +x on bash files, but be defensive.
chmod +x "$PBIN/control.sh" 2>/dev/null
chmod +x "$PBIN/tail-daemon.sh" 2>/dev/null
chmod +x "$PBIN/log-session-create.pl" 2>/dev/null
chmod +x "$PBIN/lox-getconfig.pl" 2>/dev/null
chmod +x "$PBIN/lox-getstructure.pl" 2>/dev/null
chmod +x "$PBIN/lox-send.pl" 2>/dev/null
chmod +x "$PBIN/lox-control.pl" 2>/dev/null

# ---- 5. Start the daemon ---------------------------------------------------
# Two distinct install paths land here:
#
#   - Fresh install (no marker file): $PCONFIG was either just created or
#     was preserved from a previous install LoxBerry forgot about. Auto-
#     starting the daemon is the right user experience — the default
#     BRIDGE_URL works immediately and the user can pair from the Setup
#     tab without any extra step.
#
#   - Upgrade (marker file from preupgrade.sh present): we are mid-upgrade,
#     postupgrade.sh has NOT yet run to restore the backed-up $PCONFIG.
#     If we auto-start here and LoxBerry's unpack wiped $PCONFIG, the
#     daemon would read an empty identity dir, generate a fresh random
#     userId, write it to disk, connect to the bridge with that random
#     ID — and postupgrade's subsequent identity-file restore would NOT
#     re-read into the running daemon process. The daemon would stay
#     pinned to a stale random identity until the next manual restart,
#     and every Alexa pairing previously established with the original
#     identity would be broken. Skip auto-start; postupgrade.sh handles
#     the start AFTER restoring config.
if [ -f "$PTEMPPATH/_daemon_was_running" ]; then
    echo "<INFO> Alexa Smart Home: Upgrade in progress; postupgrade.sh will start the daemon after restoring config."
else
    echo "<INFO> Alexa Smart Home: Starting daemon..."
    if "$PBIN/control.sh" start; then
        echo "<OK> Alexa Smart Home: Daemon started."
    else
        # Treat a failed start as a warning, not fatal: the files are in
        # place, the user just needs to inspect logs and start it themselves.
        echo "<WARNING> Alexa Smart Home: Daemon did not start cleanly."
        echo "<WARNING>                   Open the plugin's Setup tab or run:"
        echo "<WARNING>                     $PBIN/control.sh start"
    fi
fi

# ---- 6. Final hint ---------------------------------------------------------
if [ -f "$PTEMPPATH/_daemon_was_running" ]; then
    echo "<INFO> Alexa Smart Home: POSTINSTALL — done; postupgrade.sh will restore config and restart the daemon."
else
    echo "<INFO> Alexa Smart Home: POSTINSTALL — plugin installed and daemon running."
    echo "<INFO>                                  Open the plugin's web UI to pair Alexa."
fi

echo "<OK> Alexa Smart Home: POSTINSTALL — completed."
exit 0
