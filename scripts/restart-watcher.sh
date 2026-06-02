#!/bin/bash

# Kithkit Restart Watcher
#
# Monitors for restart-requested flag and triggers restart.
# Run as a background process via launchd.
#
# Usage:
#   ./restart-watcher.sh          # Run in foreground
#   launchd plist recommended for production use

# Source shared config
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

RESTART_FLAG="$STATE_DIR/restart-requested"
# TRANSITION-ONLY (kithkit#344): dual-poll .claude legacy path; REMOVE once all fleet agents re-synced to abs-path skill
LEGACY_RESTART_FLAG="$BASE_DIR/.claude/state/restart-requested"
LOG="$LOG_DIR/restart-watcher.log"

mkdir -p "$(dirname "$LOG")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
}

log "Restart watcher started"

while true; do
    if [ -f "$RESTART_FLAG" ] || [ -f "$LEGACY_RESTART_FLAG" ]; then  # TRANSITION-ONLY (kithkit#344): dual-poll legacy .claude path
        log "Restart flag detected, triggering restart..."
        "$SCRIPTS_DIR/restart.sh" >> "$LOG" 2>&1
        _exit=$?
        if [ $_exit -eq 0 ]; then
            log "Restart complete"
        else
            log "Restart FAILED (exit $_exit)"
        fi
    fi
    sleep 5
done
