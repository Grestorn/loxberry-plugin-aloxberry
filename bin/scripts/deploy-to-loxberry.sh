#!/usr/bin/env bash
#
# Deploy the Aloxberry plugin daemon to a LoxBerry box over SSH.
#
# What it does, in order:
#   1. rsync's bin/src, bin/lox-*.pl, and bin/package*.json to
#      $REMOTE_HOST:$REMOTE_DIR (default /tmp/aloxberry-daemon).
#   2. Runs `npm install --omit=dev` remotely to pull production deps.
#   3. Writes start.sh + env.local (non-secret env only) for the daemon.
#   4. Stops any running daemon (graceful SIGTERM, then SIGKILL after 5s).
#   5. Starts the daemon detached via setsid + nohup; logs to daemon.log.
#   6. Tails the recent lines so you see boot succeed or fail.
#
# IMPORTANT: as of step 8a (Path B), the daemon owns its OWN identity files
# (userId + skillSecret) under $DATA_DIR/identity/, generated on first boot.
# There is NO secret to paste in here anymore — pairing is done via the
# plugin's web UI (10-char one-shot code). So this script only needs to know
# WHERE the bridge is.
#
# Usage:
#   REMOTE_HOST=loxberry@loxberry.home \
#   BRIDGE_URL=https://loxhome-bridge.net \
#   ./bin/scripts/deploy-to-loxberry.sh
#
# Optional:
#   REMOTE_DIR  — install path on the LoxBerry (default /tmp/aloxberry-daemon)
#   LOG_LEVEL   — LoxBerry numeric 0-7, or pino name for back-compat (default info)
#   DATA_DIR    — daemon data dir on remote (default $REMOTE_DIR/data)

set -euo pipefail

# ----- config (env-overridable) -------------------------------------------
REMOTE_HOST="${REMOTE_HOST:-loxberry@loxberry.home}"
REMOTE_DIR="${REMOTE_DIR:-/tmp/aloxberry-daemon}"
BRIDGE_URL="${BRIDGE_URL:-https://loxhome-bridge.net}"
LOG_LEVEL="${LOG_LEVEL:-info}"
REMOTE_DATA_DIR="${DATA_DIR:-$REMOTE_DIR/data}"

# Resolve the local bin/ dir relative to this script (script lives in bin/scripts).
LOCAL_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -d "$LOCAL_BIN_DIR/src" ]]; then
    echo "ERROR: $LOCAL_BIN_DIR/src is missing — run from a checkout" >&2
    exit 2
fi

echo "==> Target: $REMOTE_HOST:$REMOTE_DIR"
echo "==> Source: $LOCAL_BIN_DIR"
echo

# ----- 1. rsync sources ---------------------------------------------------
# --delete keeps the remote tree free of stale files (e.g. when a source
# module is renamed). node_modules is excluded so we re-install remotely
# with the LoxBerry's Node version (avoids native-addon ABI mismatches).
echo "==> rsync"
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR' '$REMOTE_DATA_DIR'"
rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude 'test' \
    --exclude 'data' \
    --exclude '*.log' \
    --include 'src/' --include 'src/**' \
    --include 'lox-*.pl' \
    --include 'package.json' --include 'package-lock.json' \
    --exclude 'scripts/' \
    --exclude '*' \
    "$LOCAL_BIN_DIR/" "$REMOTE_HOST:$REMOTE_DIR/"

# ----- 2. npm install -----------------------------------------------------
echo
echo "==> npm install (remote)"
ssh "$REMOTE_HOST" "bash -lc 'cd $REMOTE_DIR && npm install --omit=dev --no-audit --no-fund'"

# ----- 3. write start wrapper --------------------------------------------
# env.local holds NON-secret runtime config only. The daemon's actual secret
# (skillSecret) lives in $DATA_DIR/identity/ and is generated on first boot;
# the deploy script never sees it and never needs to.
echo
echo "==> writing start wrapper"
ssh "$REMOTE_HOST" "umask 077 && cat > $REMOTE_DIR/env.local" <<EOF
export BRIDGE_URL='$BRIDGE_URL'
export LOG_LEVEL='$LOG_LEVEL'
export DATA_DIR='$REMOTE_DATA_DIR'
EOF

ssh "$REMOTE_HOST" "cat > $REMOTE_DIR/start.sh" <<'WRAPPER'
#!/usr/bin/env bash
# Aloxberry daemon start wrapper. Sources env.local for runtime config.
# (No secrets here — those live in $DATA_DIR/identity/, owned by the daemon.)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/env.local"
exec node "$HERE/src/index.js"
WRAPPER
ssh "$REMOTE_HOST" "chmod +x $REMOTE_DIR/start.sh"

# ----- 4. stop running daemon + 5. start fresh ---------------------------
# Combined into ONE ssh call so we don't race against sshd holding pipes from
# the previous (manually-launched) daemon. We also fully detach the new daemon:
#   - setsid                 → new session, decoupled from sshd's process group
#   - < /dev/null            → close stdin
#   - >> daemon.log 2>&1     → no inherited FDs from the ssh tty
#   - &                      → background
#   - disown                 → drop from this shell's job table
# Combined with `setsid`, the new daemon's FDs are entirely owned by itself;
# sshd has nothing left to wait on, so the ssh session closes cleanly.
#
# Kill strategy: graceful SIGTERM, wait up to 5s, then SIGKILL the holdout.
echo
echo "==> stopping any running daemon, then starting fresh"
SSH_OPTS=( -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 )
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -u
PATTERN='node .*aloxberry-daemon.*src/index.js'
PIDS=$(pgrep -f "$PATTERN" || true)
if [ -n "$PIDS" ]; then
    echo "  stopping pids: $PIDS"
    kill $PIDS 2>/dev/null || true
    for i in 1 2 3 4 5; do
        sleep 1
        PIDS=$(pgrep -f "$PATTERN" || true)
        [ -z "$PIDS" ] && break
    done
    if [ -n "$PIDS" ]; then
        echo "  force-killing stragglers: $PIDS"
        kill -9 $PIDS 2>/dev/null || true
        sleep 1
    fi
else
    echo "  no daemon running"
fi

cd "$REMOTE_DIR"
echo "  launching fresh daemon (logs: $REMOTE_DIR/daemon.log)"
setsid nohup ./start.sh < /dev/null >> daemon.log 2>&1 &
disown 2>/dev/null || true
# Give it a beat to fork + write its first log line.
sleep 1
NEW_PID=$(pgrep -f "$PATTERN" | head -1)
if [ -n "$NEW_PID" ]; then
    echo "  daemon PID=$NEW_PID"
else
    echo "  WARNING: daemon did not appear in pgrep — check daemon.log"
fi
REMOTE

# ----- 6. tail boot log --------------------------------------------------
echo
echo "==> daemon.log (last 30 lines after a 2s warmup)"
sleep 2
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "tail -30 '$REMOTE_DIR/daemon.log'" || true

echo
echo "Done. Live tail:  ssh $REMOTE_HOST 'tail -f $REMOTE_DIR/daemon.log'"
echo "Stop:             ssh $REMOTE_HOST 'pkill -f aloxberry-daemon.*src/index.js'"
