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
# The daemon needs Node 24+ (bin/package.json engines.node). LoxBerry's base
# image does NOT ship Node by default; the user must install it themselves.
# Fail loud here so the user sees the actionable error during install.

REQUIRED_MAJOR=24

echo "<INFO> Alexa Smart Home: Checking for Node.js >= ${REQUIRED_MAJOR}.x ..."

if ! command -v node >/dev/null 2>&1; then
    echo "<FAIL> Alexa Smart Home: Node.js is NOT installed."
    echo "<INFO> Install Node.js ${REQUIRED_MAJOR}.x via NodeSource (run as root once):"
    echo "<INFO>   curl -fsSL https://deb.nodesource.com/setup_${REQUIRED_MAJOR}.x | sudo -E bash -"
    echo "<INFO>   sudo apt-get install -y nodejs"
    echo "<INFO> Then re-install this plugin."
    exit 2
fi

NODE_VERSION_STR="$(node --version 2>/dev/null)"      # e.g. v24.1.0
NODE_MAJOR="$(echo "$NODE_VERSION_STR" | sed -E 's/^v?([0-9]+)\..*/\1/')"

if ! echo "$NODE_MAJOR" | grep -qE '^[0-9]+$'; then
    echo "<FAIL> Alexa Smart Home: Could not parse Node.js version from '$NODE_VERSION_STR'."
    exit 2
fi

if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
    echo "<FAIL> Alexa Smart Home: Node.js ${NODE_VERSION_STR} is too old (need >= ${REQUIRED_MAJOR}.x)."
    echo "<INFO> Upgrade via NodeSource:"
    echo "<INFO>   curl -fsSL https://deb.nodesource.com/setup_${REQUIRED_MAJOR}.x | sudo -E bash -"
    echo "<INFO>   sudo apt-get install -y nodejs"
    exit 2
fi

echo "<OK> Alexa Smart Home: Found Node.js ${NODE_VERSION_STR}."

# ---- npm sanity ------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
    echo "<FAIL> Alexa Smart Home: npm is missing (it should ship with nodejs)."
    exit 2
fi

exit 0
