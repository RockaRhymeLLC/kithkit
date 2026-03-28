#!/bin/bash
#
# Context Monitor - statusLine script
#
# Runs on every conversation update via Claude Code's statusLine feature.
# Writes context usage data to per-session files for the watchdog to read.
# Outputs a status line shown at the bottom of the Claude Code UI.
#
# Files written:
#   .kithkit/state/context-usage.json           — comms agent (default)
#   .kithkit/state/context-usage-orch.json      — orchestrator
#   .kithkit/state/context-usage-other.json     — workers / unknown sessions
#
# Configuration: Add to .kithkit/settings.json:
#   "statusLine": { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/context-monitor-statusline.sh" }

input=$(cat)

# Source shared config (provides BASE_DIR, STATE_DIR, TMUX_BIN, read_config, etc.)
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

# Ensure state directory exists
mkdir -p "$STATE_DIR"

# Detect which tmux session we're in using $TMUX_PANE (reliable).
# Note: 'tmux display-message -p' without -t uses the attached CLIENT's session,
# not the session that owns this process's pane. That's wrong when multiple sessions
# share a tmux server. Using -t "$TMUX_PANE" resolves via the pane ID instead.
CURRENT_SESSION=""
if [ -n "$TMUX_PANE" ] && [ -n "$TMUX_BIN" ]; then
  CURRENT_SESSION=$($TMUX_BIN display-message -t "$TMUX_PANE" -p '#{session_name}' 2>/dev/null || true)
fi
# Fallback: scan pane list to match by PID ancestry
if [ -z "$CURRENT_SESSION" ] && [ -n "$TMUX" ] && [ -n "$TMUX_BIN" ]; then
  CURRENT_SESSION=$($TMUX_BIN list-panes -a -F '#{pane_pid} #{session_name}' 2>/dev/null | while read pane_pid sess; do
    if [ "$pane_pid" = "$PPID" ]; then
      echo "$sess"
      break
    fi
  done)
fi

# Pick the right state file based on session
# Use read_config from config.sh (reads kithkit.config.yaml properly)
SESSION_NAME="$(get_session_name)"

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
