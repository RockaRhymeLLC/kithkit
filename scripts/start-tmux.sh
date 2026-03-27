#!/bin/bash

# Kithkit Tmux Startup Script
#
# Starts Claude Code in a persistent tmux session with auto-prompt.
# The session survives terminal close and system sleep.
# On startup, Claude automatically checks for pending work.
#
# Usage:
#   ./start-tmux.sh                    # Start new session or attach to existing
#   ./start-tmux.sh --detach           # Start detached (for launchd)
#   ./start-tmux.sh --skip-permissions # Skip Claude's permission prompts
#   Config: set claude.skip_permissions=true in kithkit.config.yaml (preferred, survives reboots)

set -e

# Source shared config
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

if [ -z "$TMUX_BIN" ]; then
    echo "Error: tmux not found. Install with: brew install tmux" >&2
    exit 1
fi

# Parse arguments
DETACH=false
SKIP_PERMISSIONS=false

for arg in "$@"; do
    case "$arg" in
        --detach) DETACH=true ;;
        --skip-permissions) SKIP_PERMISSIONS=true ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

# Check if session already exists
if session_exists; then
    if claude_alive; then
        # Session exists AND claude is running — all good
        if $DETACH; then
            echo "Session '$SESSION_NAME' already running (claude alive)"
            exit 0
        else
            exec $TMUX_CMD attach-session -t "$SESSION_NAME"
        fi
    else
        # Session exists but claude is dead — kill stale session and recreate
        echo "Session '$SESSION_NAME' exists but claude is not running — restarting"
        $TMUX_CMD kill-session -t "=$SESSION_NAME" 2>/dev/null
    fi
fi

# Build the claude arguments to pass through
CLAUDE_ARGS=()
if $SKIP_PERMISSIONS; then
    CLAUDE_ARGS+=("--dangerously-skip-permissions")
fi

if $DETACH; then
    # Start detached session with watchdog (auto-restarts Claude on exit)
    $TMUX_CMD new-session -d -s "$SESSION_NAME" -c "$BASE_DIR" \
        "'$BASE_DIR/scripts/watchdog.sh' ${CLAUDE_ARGS[*]}"

    # Auto-prompt is handled by the SessionStart hook (session-start.sh)
    # — no need to inject one here too

    echo "Started session '$SESSION_NAME' (detached, watchdog enabled)"
else
    # Start and attach interactively (no watchdog, no auto-prompt)
    exec $TMUX_CMD new-session -s "$SESSION_NAME" -c "$BASE_DIR" \
        "'$BASE_DIR/scripts/start.sh' ${CLAUDE_ARGS[*]}"
fi
