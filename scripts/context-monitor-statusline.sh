#!/bin/bash
#
# Context Monitor - statusLine script
#
# Runs on every conversation update via Claude Code's statusLine feature.
# Writes context usage data to a shared file for the watchdog to read.
# Outputs a status line shown at the bottom of the Claude Code UI.
#
# Configuration: Add to .claude/settings.json:
#   "statusLine": "scripts/context-monitor-statusline.sh"

input=$(cat)

# Source shared config
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

STATE_FILE="$STATE_DIR/context-usage.json"

# Ensure state directory exists
mkdir -p "$STATE_DIR"

# Parse context window data from stdin JSON
USED=$(/usr/bin/jq -r '.context_window.used_percentage // 0' <<< "$input" 2>/dev/null)
REMAINING=$(/usr/bin/jq -r '.context_window.remaining_percentage // 100' <<< "$input" 2>/dev/null)
WINDOW_SIZE=$(/usr/bin/jq -r '.context_window.context_window_size // 0' <<< "$input" 2>/dev/null)
SESSION_ID=$(/usr/bin/jq -r '.session_id // "unknown"' <<< "$input" 2>/dev/null)
MODEL=$(/usr/bin/jq -r '.model.display_name // "unknown"' <<< "$input" 2>/dev/null)

# Write context data to shared file for the watchdog
cat > "$STATE_FILE" << EOF
{
  "used_percentage": $USED,
  "remaining_percentage": $REMAINING,
  "context_window_size": $WINDOW_SIZE,
  "session_id": "$SESSION_ID",
  "model": "$MODEL",
  "timestamp": $(date +%s)
}
EOF

# Output status line text (shown at bottom of Claude Code UI)
echo "[$MODEL] Context: ${USED}% used"
