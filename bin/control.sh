#!/bin/bash
#
# Aloxberry daemon control script. Single daemon per LoxBerry install.
#
# Usage:
#   control.sh start          # launch detached; writes PID file
#   control.sh stop           # SIGTERM, then SIGKILL after 10s if needed
#   control.sh restart        # stop + start
#   control.sh status         # exit 0 if running, 1 if not; prints state
#   control.sh logs           # tail -F daemon.log (Ctrl-C to exit)
#
# REPLACE* placeholders below are rewritten by LoxBerry to absolute paths
# during plugin install. Do NOT change them to literal paths — the plugin
# would then break on systems where LoxBerry lives somewhere other than
# /opt/loxberry.

set -u

SCRIPT_DIR="REPLACELBPBINDIR"
DATA_DIR="REPLACELBPDATADIR"
CONFIG_DIR="REPLACELBPCONFIGDIR"
LOG_DIR="REPLACELBPLOGDIR"

DAEMON_ENTRY="$SCRIPT_DIR/src/index.js"
PID_FILE="$DATA_DIR/daemon.pid"
# The active log file path is recorded here by cmd_start (so cmd_logs +
# tail-daemon.sh can find the current session without scanning the log dir).
# A fresh LoxBerry log session is created per start; the previous file
# stays on disk and is rotated out by LoxBerry's standard log management.
CURRENT_LOG_FILE="$DATA_DIR/daemon.log.current"
LOG_SESSION_CREATE="$SCRIPT_DIR/log-session-create.pl"
DAEMON_ENV="$CONFIG_DIR/daemon.env"
IDENTITY_DIR="$CONFIG_DIR/identity"

# Ensure dirs exist (the LOG_DIR lives on a ramdisk so it's gone after reboot).
mkdir -p "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR" "$IDENTITY_DIR" 2>/dev/null
chmod 700 "$IDENTITY_DIR" 2>/dev/null

# Make sure cron's minimal PATH still finds node + npm.
case ":$PATH:" in *":/usr/local/bin:"*) ;; *) PATH="/usr/local/bin:$PATH" ;; esac
case ":$PATH:" in *":/usr/bin:"*)      ;; *) PATH="/usr/bin:$PATH"      ;; esac
export PATH

# ----- helpers -------------------------------------------------------------

get_pid() {
    [ -f "$PID_FILE" ] || return 1
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)"
    if [ -z "$pid" ]; then return 1; fi
    if ps -p "$pid" >/dev/null 2>&1; then
        echo "$pid"
        return 0
    fi
    # Stale PID file
    rm -f "$PID_FILE"
    return 1
}

is_running() {
    get_pid >/dev/null
}

# Source daemon.env if present. Otherwise fall through to whatever the
# parent shell exported (useful for ad-hoc dev `BRIDGE_URL=... start`).
load_env() {
    if [ -f "$DAEMON_ENV" ]; then
        set -a
        # shellcheck source=/dev/null
        . "$DAEMON_ENV"
        set +a
    fi
    # Required by the daemon. CONFIG_DIR is the parent of IDENTITY_DIR and
    # also holds devices.json (and daemon.env itself).
    export DATA_DIR
    export CONFIG_DIR
    export IDENTITY_DIR
}

# ----- commands ------------------------------------------------------------

cmd_start() {
    if is_running; then
        echo "Aloxberry daemon already running (PID $(get_pid))"
        return 0
    fi

    load_env
    if [ -z "${BRIDGE_URL:-}" ]; then
        echo "ERROR: BRIDGE_URL is empty. Set it in $DAEMON_ENV (or via the web UI)." >&2
        return 2
    fi

    # Open a new LoxBerry log session for this daemon instance. The shim
    # registers the session in plugin.logsessions so the web log-viewer
    # picks it up. Its stdout is two lines:
    #   line 1: file path
    #   line 2: LoxBerry numeric log level (0-7) for this plugin, or empty
    #           if unreadable. We export it as LOG_LEVEL — the daemon's
    #           custom logger (bin/src/log.js) accepts that integer
    #           directly. Single source of truth in LoxBerry's UI.
    local shim_out log_file lb_level
    shim_out="$(perl "$LOG_SESSION_CREATE")"
    log_file="$(printf '%s' "$shim_out" | sed -n '1p')"
    lb_level="$(printf '%s' "$shim_out" | sed -n '2p')"
    if [ -z "$log_file" ] || [ ! -d "$(dirname "$log_file")" ]; then
        echo "ERROR: could not create LoxBerry log session" >&2
        return 2
    fi
    echo "$log_file" > "$CURRENT_LOG_FILE"
    if [ -n "$lb_level" ]; then
        export LOG_LEVEL="$lb_level"
    fi

    echo "Starting Aloxberry daemon (BRIDGE_URL=$BRIDGE_URL, LOG_LEVEL=${LOG_LEVEL:-default}) ..."

    # nohup (not setsid) so $! is the actual node PID (setsid forks again
    # and $! then refers to a wrapper, not the daemon).
    # stdin closed, stdout/stderr to the log file, fully detached.
    nohup node "$DAEMON_ENTRY" </dev/null >>"$log_file" 2>&1 &
    local pid=$!
    disown 2>/dev/null || true
    echo "$pid" > "$PID_FILE"

    # Brief grace to let the daemon either write a boot line or crash.
    sleep 1
    if is_running; then
        echo "Aloxberry daemon started (PID $pid). Logs: $log_file"
        return 0
    fi
    echo "Aloxberry daemon failed to start. Last 20 log lines:" >&2
    tail -20 "$log_file" >&2
    return 1
}

cmd_stop() {
    if ! is_running; then
        echo "Aloxberry daemon is not running."
        rm -f "$PID_FILE"
        return 0
    fi
    local pid; pid="$(get_pid)"
    echo "Stopping Aloxberry daemon (PID $pid) ..."
    kill -TERM "$pid" 2>/dev/null || true

    # Wait up to 10s for graceful exit.
    local i=0
    while is_running && [ "$i" -lt 10 ]; do
        sleep 1
        i=$((i + 1))
    done

    if is_running; then
        echo "Daemon did not stop gracefully — sending SIGKILL."
        kill -KILL "$pid" 2>/dev/null || true
        sleep 1
    fi
    rm -f "$PID_FILE"
    echo "Aloxberry daemon stopped."
    return 0
}

cmd_restart() {
    cmd_stop
    sleep 1
    cmd_start
}

cmd_status() {
    if is_running; then
        local pid; pid="$(get_pid)"
        echo "Aloxberry daemon: RUNNING (PID $pid)"
        # If we have a state.json, show a tiny health summary.
        if [ -f "$DATA_DIR/state.json" ]; then
            echo ""
            echo "state.json:"
            cat "$DATA_DIR/state.json"
        fi
        return 0
    fi
    echo "Aloxberry daemon: STOPPED"
    return 1
}

cmd_logs() {
    local log_file=""
    if [ -f "$CURRENT_LOG_FILE" ]; then
        log_file="$(cat "$CURRENT_LOG_FILE")"
    fi
    if [ -z "$log_file" ] || [ ! -f "$log_file" ]; then
        echo "No log file yet. Has the daemon ever started?"
        return 1
    fi
    tail -n 50 -F "$log_file"
}

# ----- dispatch ------------------------------------------------------------

case "${1:-}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    logs)    cmd_logs ;;
    *)
        cat <<USAGE
Usage: $0 {start|stop|restart|status|logs}

  start    Launch the daemon under nohup (detached). Writes daemon.pid.
  stop     SIGTERM then SIGKILL after 10s. Removes daemon.pid.
  restart  stop + start.
  status   Prints "RUNNING (PID ...)" or "STOPPED" and last state.json.
  logs     tail -F daemon.log.

Files:
  Daemon entry : $DAEMON_ENTRY
  PID file     : $PID_FILE
  Log pointer  : $CURRENT_LOG_FILE  (contains the path to the active session log)
  Log dir      : $LOG_DIR  (LoxBerry-managed; sessions auto-rotated)
  Env file     : $DAEMON_ENV
  Identity dir : $IDENTITY_DIR  (userId, skillSecret — preserved across upgrades)
USAGE
        exit 2
        ;;
esac
