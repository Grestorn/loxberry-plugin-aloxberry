#!/usr/bin/env bash
#
# Continuously tail the Aloxberry daemon log on the LoxBerry.
#
# Reads /tmp/aloxberry-daemon/daemon.log via `tail -F` (capital F follows file
# replacement, so log rotation doesn't break the stream). The daemon now
# writes LoxBerry-flavoured plain text (bin/src/log.js) — no pretty-printer
# in the pipeline.
#
# Usage:
#   ./bin/scripts/tail-loxberry.sh                # default: last 50 lines + live
#   ./bin/scripts/tail-loxberry.sh 200            # show last 200 lines first
#   REMOTE_HOST=user@host ./bin/scripts/tail-loxberry.sh
#
# Ctrl-C exits cleanly (both ends).

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-loxberry@loxberry.home}"
REMOTE_LOG="${REMOTE_LOG:-/tmp/aloxberry-daemon/daemon.log}"

LINES=50
for arg in "$@"; do
    case "$arg" in
        --help|-h)
            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        ''|*[!0-9]*) echo "unknown argument: $arg" >&2; exit 2 ;;
        *) LINES="$arg" ;;
    esac
done

# IMPORTANT: do NOT use `ssh -t` or `-tt` here. A PTY would translate every
# `\n` from the remote into `\r\n`, breaking line-ends in Windows Terminal
# / IntelliJ / WSL consoles.
#
# Without `-t`, ssh sets up a clean binary stdout pipe (LF-only). Ctrl-C is
# still propagated: killing the local ssh process closes the TCP connection,
# and sshd SIGHUPs the remote `tail` as part of session teardown.
#
# `-n` explicitly disables stdin reading so a stray keystroke can't be
# interpreted as input on the remote side.
exec ssh -n \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$REMOTE_HOST" \
    "tail -n $LINES -F '$REMOTE_LOG'"
