#!/bin/bash
#
# Runs BEFORE LoxBerry unpacks the plugin files. Use to sanity-check
# prerequisites; fail with exit 2 to abort install with a clear message.
#
# Runs as `loxberry`. /etc/environment env vars are available.

COMMAND=$0
PTEMPDIR=$1
PSHNAME=$2
PDIR=$3
PVERSION=$4
PTEMPPATH=$6

# ---- Node.js version check ------------------------------------------------
# The daemon needs Node 18+ (bin/package.json engines.node). The hard floor is
# really ~Node 17 (the daemon uses the global structuredClone, added in 17.0),
# so 18 is the lowest version we support — it covers the 18.16 that some
# LoxBerry images ship by default. LoxBerry's base image does NOT ship Node;
# the user must install it themselves. Fail loud here so the user sees the
# actionable error during install.

REQUIRED_MAJOR=18

echo "<INFO> Aloxberry: Checking for Node.js >= ${REQUIRED_MAJOR}.x ..."

if ! command -v node >/dev/null 2>&1; then
    echo "<FAIL> Aloxberry: Node.js is NOT installed."
    echo "<INFO> Install Node.js >= ${REQUIRED_MAJOR}.x, then re-install this plugin."
    echo "<INFO> Use your system's package (e.g. 'apt-get install nodejs npm')."
    echo "<INFO> Do NOT pipe NodeSource into 'sudo bash' — that can replace the"
    echo "<INFO> system Node.js LoxBerry itself relies on and break the appliance."
    exit 2
fi

NODE_VERSION_STR="$(node --version 2>/dev/null)"      # e.g. v18.16.0
NODE_MAJOR="$(echo "$NODE_VERSION_STR" | sed -E 's/^v?([0-9]+)\..*/\1/')"

if ! echo "$NODE_MAJOR" | grep -qE '^[0-9]+$'; then
    echo "<FAIL> Aloxberry: Could not parse Node.js version from '$NODE_VERSION_STR'."
    exit 2
fi

if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
    echo "<FAIL> Aloxberry: Node.js ${NODE_VERSION_STR} is too old (need >= ${REQUIRED_MAJOR}.x)."
    echo "<INFO> Upgrade Node.js to >= ${REQUIRED_MAJOR}.x using your system's package"
    echo "<INFO> manager, then re-install this plugin. Do NOT pipe NodeSource into"
    echo "<INFO> 'sudo bash' — that can replace the Node.js LoxBerry relies on."
    exit 2
fi

echo "<OK> Aloxberry: Found Node.js ${NODE_VERSION_STR}."

# ---- npm sanity ------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
    echo "<FAIL> Aloxberry: npm is missing (it should ship with nodejs)."
    exit 2
fi

exit 0
