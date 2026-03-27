#!/bin/bash

# Kithkit Watchdog Script
#
# Runs start.sh in a loop, restarting Claude if it exits.
# Designed to be the tmux pane command for detached/launchd sessions.
#
# Features:
#   - Restarts Claude automatically on exit
#   - Backs off on rapid failures (exit within 30s = startup error)
#   - Stops after 5 rapid failures to prevent infinite crash loops
#
# Usage:
#   ./watchdog.sh [start.sh arguments...]

# Clear Claude Code nesting guard — the tmux session is a separate instance,
# not a nested one. Without this, launching from an existing Claude session
# (e.g., restart triggered by comms) fails with "cannot launch inside another
# Claude Code session".
unset CLAUDECODE

# Source shared config
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

START_SCRIPT="$SCRIPTS_DIR/start.sh"

rapid_failures=0
max_rapid=5

while true; do
    start_time=$(date +%s)
    "$START_SCRIPT" "$@"
    exit_code=$?
    elapsed=$(( $(date +%s) - start_time ))

    if [ $elapsed -lt 30 ]; then
        rapid_failures=$(( rapid_failures + 1 ))
        echo "[watchdog] Claude exited after ${elapsed}s (exit $exit_code), rapid failure $rapid_failures/$max_rapid"
        if [ $rapid_failures -ge $max_rapid ]; then
            echo "[watchdog] Too many rapid failures — stopping. Manual restart required."
            break
        fi
        echo "[watchdog] Waiting 15s before retry..."
        sleep 15
    else
        rapid_failures=0
        echo "[watchdog] Claude exited after ${elapsed}s (exit $exit_code), restarting in 3s..."
        sleep 3
    fi
done
