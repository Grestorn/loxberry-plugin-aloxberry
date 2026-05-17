#!/bin/bash
#
# Tail the Aloxberry daemon log from a LoxBerry SSH session.
#
# The daemon writes LoxBerry-flavoured plain text via bin/src/log.js, so
# there's no JSON-to-text post-processing step — `tail -F` is the whole
# implementation.
#
# Usage:
#   tail-daemon.sh             # last 50 lines + live
#   tail-daemon.sh 200         # last 200 lines first

set -u

SCRIPT_DIR="REPLACELBPBINDIR"
DATA_DIR="REPLACELBPDATADIR"
LOG_DIR="REPLACELBPLOGDIR"
# Pointer file written by control.sh on each `start` — contains the absolute
# path of the currently-active LoxBerry log session file.
CURRENT_LOG_FILE="$DATA_DIR/daemon.log.current"

LINES=50
for arg in "$@"; do
    case "$arg" in
        --help|-h)
            sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        ''|*[!0-9]*)
            echo "unknown argument: $arg" >&2; exit 2 ;;
        *) LINES="$arg" ;;
    esac
done

LOG_FILE=""
if [ -f "$CURRENT_LOG_FILE" ]; then
    LOG_FILE="$(cat "$CURRENT_LOG_FILE")"
fi
if [ -z "$LOG_FILE" ] || [ ! -f "$LOG_FILE" ]; then
    echo "No active daemon log session." >&2
    echo "Has the daemon ever run? Try:  $SCRIPT_DIR/control.sh start" >&2
    exit 1
fi

# tail -F follows recreation, useful if the log gets rotated/wiped.
exec tail -n "$LINES" -F "$LOG_FILE"
