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
LOG="$LOG_DIR/restart-watcher.log"

mkdir -p "$(dirname "$LOG")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
}

log "Restart watcher started"

while true; do
    if [ -f "$RESTART_FLAG" ]; then
        log "Restart flag detected, triggering restart..."
        "$SCRIPTS_DIR/restart.sh" >> "$LOG" 2>&1
        log "Restart complete"
    fi
    sleep 5
done
