#!/bin/bash
#
# Context Monitor - statusLine script
#
# Runs on every conversation update via Claude Code's statusLine feature.
# Writes context usage data to per-session files for the watchdog to read.
# Outputs a status line shown at the bottom of the Claude Code UI.
#
# Files written:
#   .claude/state/context-usage.json           — comms agent (default)
#   .claude/state/context-usage-orch.json      — orchestrator
#
# Configuration: Add to .claude/settings.json:
#   "statusLine": { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/context-monitor-statusline.sh" }

input=$(cat)

# Source shared config
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

# Ensure state directory exists
mkdir -p "$STATE_DIR"

# Detect which tmux session we're in
TMUX_BIN="/opt/homebrew/bin/tmux"
CURRENT_SESSION=""
if [ -n "$TMUX" ]; then
  CURRENT_SESSION=$($TMUX_BIN display-message -p '#{session_name}' 2>/dev/null || true)
fi

# Pick the right state file based on session
SESSION_NAME=$(grep -A1 '^tmux:' "$PROJECT_DIR/kithkit.config.yaml" 2>/dev/null | grep 'session:' | sed 's/.*session:[[:space:]]*//' | tr -d '"' | tr -d "'")
SESSION_NAME="${SESSION_NAME:-cc4me}"

if [ -n "$CURRENT_SESSION" ] && [ "$CURRENT_SESSION" = "${SESSION_NAME}-orch" ]; then
  STATE_FILE="$STATE_DIR/context-usage-orch.json"
  AGENT_ROLE="orchestrator"
elif [ -z "$CURRENT_SESSION" ] || [ "$CURRENT_SESSION" = "$SESSION_NAME" ]; then
  STATE_FILE="$STATE_DIR/context-usage.json"
  AGENT_ROLE="comms"
else
  # Unknown session (worker?) — write to a generic file, don't clobber comms/orch
  STATE_FILE="$STATE_DIR/context-usage-other.json"
  AGENT_ROLE="worker"
fi

# Parse context window data from stdin JSON
USED=$(/usr/bin/jq -r '.context_window.used_percentage // 0' <<< "$input" 2>/dev/null)
REMAINING=$(/usr/bin/jq -r '.context_window.remaining_percentage // 100' <<< "$input" 2>/dev/null)
WINDOW_SIZE=$(/usr/bin/jq -r '.context_window.context_window_size // 0' <<< "$input" 2>/dev/null)
SESSION_ID=$(/usr/bin/jq -r '.session_id // "unknown"' <<< "$input" 2>/dev/null)
MODEL=$(/usr/bin/jq -r '.model.display_name // "unknown"' <<< "$input" 2>/dev/null)

# Write context data
cat > "$STATE_FILE" << EOF
{
  "used_percentage": $USED,
  "remaining_percentage": $REMAINING,
  "context_window_size": $WINDOW_SIZE,
  "session_id": "$SESSION_ID",
  "model": "$MODEL",
  "agent_role": "$AGENT_ROLE",
  "timestamp": $(date +%s)
}
EOF

# Output status line text (shown at bottom of Claude Code UI)
echo "[$MODEL] Context: ${USED}% used"
