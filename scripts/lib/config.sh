#!/bin/bash

# Kithkit Shared Configuration
#
# Source this from any Kithkit script:
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/config.sh"
#
# Reads from kithkit.config.yaml (single source of truth).
# Environment variables override YAML values.
#
# Provides:
#   BASE_DIR           - Project root directory
#   SESSION_NAME       - tmux session name
#   TMUX_BIN           - Path to tmux binary
#   TMUX_CMD           - Full tmux command (with socket if needed)
#   STATE_DIR          - .kithkit/state directory
#   LOG_DIR            - logs directory
#   read_config()      - Read a value from kithkit.config.yaml
#   get_session_name() - Get the tmux session name
#   get_agent_name()   - Get the configured agent name
#   session_exists()   - Check if tmux session is running
#   claude_alive()     - Check if claude is running in the session
#   kithkit_log()      - Log with timestamp

# Resolve project root (two levels up from lib/)
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "$LIB_DIR")"
BASE_DIR="$(dirname "$SCRIPTS_DIR")"

# Config file: kithkit.config.yaml (user), falls back to kithkit.defaults.yaml
CONFIG_FILE="$BASE_DIR/kithkit.config.yaml"
DEFAULTS_FILE="$BASE_DIR/kithkit.defaults.yaml"

# Read a value from config YAML (user config, falling back to defaults)
# Usage: read_config '.agent.name' 'default_value'
read_config() {
    local key="$1"
    local default="$2"

    # Try user config first, then defaults
    for file in "$CONFIG_FILE" "$DEFAULTS_FILE"; do
        if [ ! -f "$file" ]; then
            continue
        fi

        # Try yq first (handles nested keys properly)
        if command -v yq >/dev/null 2>&1; then
            local val
            val=$(yq -r "$key // empty" "$file" 2>/dev/null)
            if [ -n "$val" ] && [ "$val" != "null" ]; then
                echo "$val"
                return
            fi
        fi

        # Path-aware awk fallback: walks YAML indentation hierarchy to resolve
        # the full dotted key path, not just the leaf name. This prevents
        # leaf-name collisions (e.g. .agent.model vs .voice.stt.model).
        local val
        val=$(awk -v key_path="$key" '
BEGIN {
    sub(/^\./, "", key_path)
    n = split(key_path, segs, "\\.")
    depth = 0
}
/^[[:space:]]*(#|$)/ { next }
{
    spaces = 0; i = 1
    while (i <= length($0) && substr($0, i, 1) == " ")  { spaces++;    i++ }
    while (i <= length($0) && substr($0, i, 1) == "\t") { spaces += 2; i++ }
    line = substr($0, i)
    if (length(line) == 0 || substr(line, 1, 1) == "-") next
    colon = index(line, ":")
    if (colon == 0) next
    k = substr(line, 1, colon - 1); v = substr(line, colon + 1)
    gsub(/[[:space:]]/, "", k)
    if (k == "") next
    while (depth > 0 && spaces <= parent_indent[depth]) depth--
    if (depth == 0 && spaces != 0) next
    if (depth < n && k == segs[depth + 1]) {
        if (depth + 1 == n) {
            sub(/^[[:space:]]*/, "", v); sub(/[[:space:]]*#.*$/, "", v)
            vl = length(v)
            if (vl > 0 && (substr(v,1,1) == "\"" || substr(v,1,1) == "\047")) { v = substr(v,2); vl-- }
            if (vl > 0 && (substr(v,vl,1) == "\"" || substr(v,vl,1) == "\047")) v = substr(v,1,vl-1)
            if (v != "") { print v; exit }
        } else { parent_indent[depth+1] = spaces; depth++ }
    }
}
' "$file" 2>/dev/null)
        if [ -n "$val" ]; then
            echo "$val"
            return
        fi
    done

    echo "$default"
}

# Get the configured agent name
get_agent_name() {
    read_config '.agent.name' 'Assistant'
}

# Get the tmux session name
get_session_name() {
    echo "${KITHKIT_SESSION:-$(read_config '.tmux.session' "$(basename "$BASE_DIR")")}"
}

# Session name: env override > config > directory name
SESSION_NAME="$(get_session_name)"

# Find tmux binary
if [ -x /opt/homebrew/bin/tmux ]; then
    TMUX_BIN=/opt/homebrew/bin/tmux
elif command -v tmux >/dev/null 2>&1; then
    TMUX_BIN=$(command -v tmux)
else
    TMUX_BIN=""
fi

# tmux socket: env override > config > system default
_YAML_SOCKET="$(read_config '.tmux.socket' '')"
TMUX_SOCKET="${KITHKIT_TMUX_SOCKET:-$_YAML_SOCKET}"

if [ -n "$TMUX_SOCKET" ]; then
    TMUX_CMD="$TMUX_BIN -S $TMUX_SOCKET"
else
    TMUX_CMD="$TMUX_BIN"
fi

# Standard directories
STATE_DIR="$BASE_DIR/.kithkit/state"
LOG_DIR="$BASE_DIR/logs"

# Check if the Kithkit tmux session exists
session_exists() {
    [ -n "$TMUX_BIN" ] && $TMUX_CMD has-session -t "=$SESSION_NAME" 2>/dev/null
}

# Check if a PID's executable is exactly "claude" (basename match, not substring)
_pid_is_claude() {
    local pid="$1"
    local cmd
    cmd=$(ps -o comm= -p "$pid" 2>/dev/null)
    [ -n "$cmd" ] && [ "$(basename "$cmd")" = "claude" ]
}

# Check if claude is actually running inside the tmux session pane
# Returns 0 if alive, 1 if session exists but claude is dead
# Handles both direct exec (claude IS the pane process) and watchdog
# (claude is a descendant of the pane process, at any depth)
claude_alive() {
    if ! session_exists; then
        return 1
    fi
    local pane_pid
    pane_pid=$($TMUX_CMD list-panes -t "=$SESSION_NAME" -F '#{pane_pid}' 2>/dev/null | head -1)
    if [ -z "$pane_pid" ]; then
        return 1
    fi
    # Check if the pane process itself is claude
    _pid_is_claude "$pane_pid" && return 0
    # Check descendants (watchdog mode: claude is a child/grandchild/etc).
    # NOTE: on macOS, pgrep's -a flag means "include ancestors in the match
    # list" — NOT "show full command line with args" like GNU/procps pgrep.
    # `pgrep -a -P "$pid" | grep -q claude` therefore silently prints bare
    # PIDs on macOS and never matches, so claude_alive always reported
    # "dead" for watchdog-mode sessions and triggered a kill of an
    # otherwise-healthy session. Walk descendants with ps + exact basename
    # matching instead — portable, and immune to substring false-matches
    # (e.g. a path that merely contains "claude", like a worktree name).
    local queue=("$pane_pid")
    local depth=0
    while [ "${#queue[@]}" -gt 0 ] && [ "$depth" -lt 6 ]; do
        local next_queue=()
        local pid child
        for pid in "${queue[@]}"; do
            for child in $(pgrep -P "$pid" 2>/dev/null); do
                _pid_is_claude "$child" && return 0
                next_queue+=("$child")
            done
        done
        queue=("${next_queue[@]}")
        depth=$((depth + 1))
    done
    return 1
}

# Log with timestamp
kithkit_log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}
