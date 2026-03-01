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
#   STATE_DIR          - .claude/state directory
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

        # Fallback: grep for simple top-level or one-level-deep keys
        local leaf="${key##*.}"
        local val
        val=$(grep -E "^[[:space:]]*${leaf}:" "$file" 2>/dev/null | head -1 | sed 's/^[^:]*:[[:space:]]*//' | sed 's/[[:space:]]*#.*//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//')
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
STATE_DIR="$BASE_DIR/.claude/state"
LOG_DIR="$BASE_DIR/logs"

# Check if the Kithkit tmux session exists
session_exists() {
    [ -n "$TMUX_BIN" ] && $TMUX_CMD has-session -t "=$SESSION_NAME" 2>/dev/null
}

# Check if claude is actually running inside the tmux session pane
# Returns 0 if alive, 1 if session exists but claude is dead
# Handles both direct exec (claude IS the pane process) and watchdog
# (claude is a descendant of the pane process)
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
    local pane_cmd
    pane_cmd=$(ps -o comm= -p "$pane_pid" 2>/dev/null)
    if [[ "$pane_cmd" == *claude* ]]; then
        return 0
    fi
    # Check descendants (watchdog mode: claude is a child/grandchild)
    pgrep -a -P "$pane_pid" 2>/dev/null | grep -q 'claude' && return 0
    # Also check grandchildren (watchdog -> start.sh -> claude)
    for child in $(pgrep -P "$pane_pid" 2>/dev/null); do
        pgrep -a -P "$child" 2>/dev/null | grep -q 'claude' && return 0
    done
    return 1
}

# Log with timestamp
kithkit_log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}
