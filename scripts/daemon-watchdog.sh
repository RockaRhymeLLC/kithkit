#!/usr/bin/env bash
# daemon-watchdog.sh — Kithkit daemon health watchdog with circuit breaker
#
# Detects a wedged Node.js event loop (process alive but HTTP unresponsive)
# and auto-kickstarts the daemon via launchd.  Designed to run every 2
# minutes under its own launchd plist (com.kithkit.daemon-watchdog).
#
# Usage:
#   daemon-watchdog.sh [--dry-run] [--health-url <url>] [--help]
#
# Exit codes:
#   0  Daemon healthy, kickstart succeeded, or --dry-run ran cleanly
#   1  Kickstart attempted but failed
#   2  Circuit breaker tripped (manual intervention required)

# Do NOT set -e at the top level — curl failure is expected and handled below.
# set -u catches unbound variables; set -o pipefail helps with pipelines.
set -uo pipefail

# ---------------------------------------------------------------------------
# Paths — all derived from SCRIPT_DIR so launchd (PWD=/) works correctly
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$REPO_ROOT/logs"
LOCK_FILE="$LOGS_DIR/watchdog.lock"
LOG_FILE="$LOGS_DIR/watchdog.log"
STATE_FILE="$LOGS_DIR/watchdog-state"
STATE_TMP="$LOGS_DIR/watchdog-state.tmp.$$"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
HEALTH_URL="http://localhost:3847/health"
DRY_RUN=false
LAUNCHD_LABEL="com.assistant.daemon"
LAUNCHD_UID="$(id -u)"

# Circuit breaker settings
CB_WINDOW_SECS=600   # 10 minutes rolling window
CB_MAX_KICKS=3       # trip when kickstart_count >= this within the window
CB_RESET_SECS=300    # reset counter after 5+ minutes of no failures

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
    cat <<'EOF'
Usage: daemon-watchdog.sh [OPTIONS]

Checks the Kithkit daemon health endpoint and kickstarts it via launchd
if unresponsive.  Implements a circuit breaker to prevent restart storms.

Options:
  --dry-run           Log what would happen but do not call launchctl
  --health-url <url>  Override the default health URL
                      (default: http://localhost:3847/health)
  --help              Show this message and exit 0

Exit codes:
  0  Daemon healthy, kickstart succeeded, or --dry-run ran cleanly
  1  Kickstart attempted but launchctl returned non-zero
  2  Circuit breaker tripped (too many restarts in 10 minutes)

State files (in logs/):
  watchdog.log        — one-line events: failures, kickstarts, circuit opens
  watchdog-state      — circuit breaker counters (key=value)
  watchdog.lock       — advisory PID lock (removed on exit)
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --health-url)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --health-url requires a value" >&2
                exit 1
            fi
            HEALTH_URL="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Ensure logs directory exists
# ---------------------------------------------------------------------------
mkdir -p "$LOGS_DIR"

# ---------------------------------------------------------------------------
# Advisory PID lock — exit quietly (0) if another instance is already running.
#
# macOS has no flock(1).  We use bash's noclobber flag (set -C) which makes
# ">" fail atomically if the file already exists — POSIX guarantees this is
# done with O_EXCL | O_CREAT under the hood.  If creation fails we check
# whether the stored PID is still live (to clear stale locks).
# ---------------------------------------------------------------------------
acquire_lock() {
    # Enable noclobber so ">" on an existing file fails (O_EXCL semantics)
    set -C
    if (echo "$$" > "$LOCK_FILE") 2>/dev/null; then
        # We created the file — we hold the lock
        set +C
        return 0
    fi
    set +C

    # File already exists — check if the stored PID is still alive
    local existing_pid
    existing_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
        # Live instance holds the lock — exit silently
        exit 0
    fi

    # Stale lock (dead PID) — forcibly clear and retry once
    rm -f "$LOCK_FILE"
    set -C
    if (echo "$$" > "$LOCK_FILE") 2>/dev/null; then
        set +C
        return 0
    fi
    set +C
    # Another instance grabbed it during our retry — give up silently
    exit 0
}

release_lock() {
    # Only remove the lock if it still contains our PID
    local stored
    stored=$(cat "$LOCK_FILE" 2>/dev/null || true)
    if [[ "$stored" == "$$" ]]; then
        rm -f "$LOCK_FILE"
    fi
}

trap release_lock EXIT
acquire_lock

# ---------------------------------------------------------------------------
# Timestamp helper — ISO-8601 UTC
# ---------------------------------------------------------------------------
iso_ts() {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
}

# ---------------------------------------------------------------------------
# Append one line to the watchdog log
# ---------------------------------------------------------------------------
log_event() {
    echo "$(iso_ts) $*" >> "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# State file helpers (simple key=value, one per line)
#
# Values must not contain newlines.  Keys are [A-Za-z0-9_]+.
# Writes are atomic: write to .tmp then mv over the real file.
# ---------------------------------------------------------------------------
read_state() {
    local key="$1"
    local default="${2:-}"
    if [[ -f "$STATE_FILE" ]]; then
        # Match "key=" at the start of a line; take everything after the first =
        local line
        line=$(grep -E "^${key}=" "$STATE_FILE" 2>/dev/null | tail -1 || true)
        if [[ -n "$line" ]]; then
            # Strip the "key=" prefix — handles values that may contain =
            echo "${line#*=}"
            return
        fi
    fi
    echo "$default"
}

# write_state KEY=VALUE [KEY=VALUE ...]
# Merges provided pairs into the existing state file, then writes atomically.
# Compatible with bash 3.2 (no associative arrays).
write_state() {
    # Write updates to a temp file so awk can read them (awk -v can't handle newlines)
    local updates_tmp
    updates_tmp=$(mktemp /tmp/watchdog-ws.XXXXXX)
    for pair in "$@"; do
        echo "$pair" >> "$updates_tmp"
    done

    # Use awk to merge:
    #   FNR==NR  → first file (updates_tmp): build key→value map
    #   FNR!=NR  → second file (state file): pass through lines NOT in update map
    # Then END: emit the updated key=value pairs
    awk '
    FNR==NR {
        if ($0 == "") { next }
        eq = index($0, "=")
        k = substr($0, 1, eq-1)
        v = substr($0, eq+1)
        new_keys[k] = v
        order[length(order)+1] = k
        next
    }
    /=/ {
        eq = index($0, "=")
        k = substr($0, 1, eq-1)
        if (!(k in new_keys)) {
            print $0
        }
    }
    END {
        for (i = 1; i <= length(order); i++) {
            k = order[i]
            print k "=" new_keys[k]
        }
    }
    ' "$updates_tmp" "${STATE_FILE:-/dev/null}" 2>/dev/null > "$STATE_TMP"

    rm -f "$updates_tmp"
    mv "$STATE_TMP" "$STATE_FILE"
}

# Remove a key from the state file (if present)
delete_state_key() {
    local key="$1"
    if [[ -f "$STATE_FILE" ]]; then
        grep -v -E "^${key}=" "$STATE_FILE" > "$STATE_TMP" 2>/dev/null || true
        mv "$STATE_TMP" "$STATE_FILE"
    fi
}

# ---------------------------------------------------------------------------
# Health check
# Returns "HTTP_CODE:CURL_EXIT" on stdout
# ---------------------------------------------------------------------------
do_health_check() {
    local http_code curl_exit err_tmp out_tmp
    err_tmp=$(mktemp /tmp/watchdog-curl-err.XXXXXX)
    out_tmp=$(mktemp /tmp/watchdog-curl-out.XXXXXX)

    # Write http_code to a temp file so we can capture both the exit code
    # AND the -w output without command substitution swallowing the exit code.
    curl --max-time 5 --connect-timeout 3 \
        -s -o /dev/null -w '%{http_code}' \
        "$HEALTH_URL" > "$out_tmp" 2>"$err_tmp"
    curl_exit=$?

    http_code=$(cat "$out_tmp")
    rm -f "$err_tmp" "$out_tmp"
    echo "${http_code:-000}:${curl_exit}"
}

# ---------------------------------------------------------------------------
# Classify a failure given (http_code, curl_exit)
# ---------------------------------------------------------------------------
classify_failure() {
    local http_code="$1"
    local curl_exit="$2"

    if [[ "$curl_exit" -eq 28 ]]; then
        echo "timeout"
    elif [[ "$curl_exit" -eq 7 ]]; then
        echo "connect-refused"
    elif [[ "$curl_exit" -eq 0 ]]; then
        local code="${http_code:-0}"
        if [[ "$code" =~ ^5 ]]; then
            echo "http-5xx"
        else
            echo "other"
        fi
    else
        echo "other"
    fi
}

# ---------------------------------------------------------------------------
# Circuit breaker
#
# Returns 0 (kickstart ALLOWED) or 1 (circuit OPEN, do not kickstart).
# When allowed, increments the counter in state.
# ---------------------------------------------------------------------------
check_circuit_breaker() {
    local now
    now=$(date +%s)

    local window_start kick_count
    window_start=$(read_state "window_start_ts" "0")
    kick_count=$(read_state "kickstart_count" "0")

    local window_age=$(( now - window_start ))

    # If the current window is older than CB_WINDOW_SECS, start a fresh one
    if [[ "$window_age" -gt "$CB_WINDOW_SECS" ]]; then
        kick_count=0
        window_start=$now
        write_state "window_start_ts=${now}" "kickstart_count=0"
    fi

    # TRIP if we have already fired CB_MAX_KICKS times in this window
    if [[ "$kick_count" -ge "$CB_MAX_KICKS" ]]; then
        log_event "CIRCUIT OPEN: daemon may be broken, giving up until manual intervention (${kick_count} kickstarts in last 10m)"
        return 1
    fi

    # Allowed — increment the counter (window_start was already set/preserved above)
    local new_count=$(( kick_count + 1 ))
    write_state "window_start_ts=${window_start}" "kickstart_count=${new_count}"
    return 0
}

# ---------------------------------------------------------------------------
# Reset circuit breaker on healthy run (if idle long enough)
# ---------------------------------------------------------------------------
maybe_reset_circuit_breaker() {
    local now
    now=$(date +%s)

    local last_failure
    last_failure=$(read_state "last_failure_ts" "0")

    # last_failure=0 means never failed — nothing to reset
    if [[ "$last_failure" -eq 0 ]]; then
        return
    fi

    local idle=$(( now - last_failure ))
    if [[ "$idle" -ge "$CB_RESET_SECS" ]]; then
        write_state "kickstart_count=0"
        delete_state_key "window_start_ts"
    fi
}

# ---------------------------------------------------------------------------
# Execute kickstart (or dry-run it)
# ---------------------------------------------------------------------------
do_kickstart() {
    local cmd_label cmd_uid
    cmd_label="$LAUNCHD_LABEL"
    cmd_uid="$LAUNCHD_UID"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_event "DRY-RUN would-kickstart: launchctl kickstart -k gui/${cmd_uid}/${cmd_label}"
        return 0
    fi

    local err_tmp rc
    err_tmp=$(mktemp /tmp/watchdog-ks-err.XXXXXX)

    launchctl kickstart -k "gui/${cmd_uid}/${cmd_label}" 2>"$err_tmp"
    rc=$?

    if [[ "$rc" -eq 0 ]]; then
        log_event "kickstarted"
        rm -f "$err_tmp"
        return 0
    else
        local err_msg
        err_msg=$(tr '\n' ' ' < "$err_tmp")
        rm -f "$err_tmp"
        log_event "kickstart-failed rc=${rc} err=\"${err_msg}\""
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
health_result=$(do_health_check)
http_code="${health_result%%:*}"
curl_exit="${health_result##*:}"

# Determine if healthy: curl exit 0 AND HTTP 2xx
is_healthy=false
if [[ "$curl_exit" -eq 0 ]]; then
    if [[ "$http_code" =~ ^2 ]]; then
        is_healthy=true
    fi
fi

if [[ "$is_healthy" == "true" ]]; then
    # Healthy — possibly reset the circuit breaker counter if we've been quiet
    maybe_reset_circuit_breaker
    exit 0
fi

# ---- Failure path ----

failure_type=$(classify_failure "$http_code" "$curl_exit")
now_epoch=$(date +%s)

# Write last_failure_ts before the circuit breaker check (so reset logic works)
write_state "last_failure_ts=${now_epoch}"

# Log the failure
log_event "failure type=${failure_type} http_code=${http_code} curl_exit=${curl_exit}"

# Check circuit breaker — trips at CB_MAX_KICKS within CB_WINDOW_SECS
if ! check_circuit_breaker; then
    exit 2
fi

# Attempt the kickstart
if do_kickstart; then
    exit 0
else
    exit 1
fi
