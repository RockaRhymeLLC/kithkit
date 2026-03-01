#!/bin/bash
#
# SessionStart Hook (v3)
#
# Minimal bootstrap: injects only what the agent can't self-load.
# The agent loads everything else (todos, calendar, memory) via its own skills.
#
# Outputs: identity, autonomy mode, daemon status, saved state.
# Then triggers the agent to self-bootstrap via the Session Start Checklist.
#
# Fires on: startup, resume, clear, compact
# Set CC4ME_QUIET_START=1 to suppress auto-resume injection (useful for debugging).

set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="$PROJECT_DIR/.claude/state"

# Read hook input from stdin (consume stdin so it doesn't block)
HOOK_INPUT=$(cat)
SOURCE=$(echo "$HOOK_INPUT" | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/')

# Check if daemon is running
DAEMON_RUNNING=false
if curl -s --connect-timeout 1 --max-time 2 "http://localhost:3847/status" > /dev/null 2>&1; then
  DAEMON_RUNNING=true
fi

# Output will be added to Claude's context
echo "## Session Context"
echo ""

# Load identity if exists
if [ -f "$STATE_DIR/identity.json" ]; then
  NAME=$(cat "$STATE_DIR/identity.json" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/')
  if [ -n "$NAME" ]; then
    echo "### Identity"
    echo "Assistant name: $NAME"
    echo ""
  fi
fi

# Load autonomy mode if exists
if [ -f "$STATE_DIR/autonomy.json" ]; then
  MODE=$(cat "$STATE_DIR/autonomy.json" | grep -o '"mode"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/')
  if [ -n "$MODE" ]; then
    echo "### Autonomy Mode"
    echo "Current mode: $MODE"
    case "$MODE" in
      yolo)
        echo "- Take any action without asking"
        echo "- Full autonomy enabled"
        ;;
      confident)
        echo "- Ask for permission on destructive actions only"
        echo "- git push, file deletes, etc need confirmation"
        ;;
      cautious)
        echo "- Ask before any state-changing operation"
        echo "- Read operations are autonomous"
        ;;
      supervised)
        echo "- Ask for confirmation on every action"
        echo "- Maximum oversight mode"
        ;;
    esac
    echo ""
  fi
fi

# Load saved state if exists and has meaningful content
if [ -f "$STATE_DIR/assistant-state.md" ]; then
  LINES=$(wc -l < "$STATE_DIR/assistant-state.md" | tr -d ' ')
  if [ "$LINES" -gt 3 ]; then
    # Check state file freshness — warn if it's older than 1 hour
    STATE_AGE=$(( $(date +%s) - $(stat -f %m "$STATE_DIR/assistant-state.md" 2>/dev/null || echo 0) ))
    if [ "$STATE_AGE" -gt 3600 ]; then
      STATE_AGE_HOURS=$(( STATE_AGE / 3600 ))
      echo "### Saved State (WARNING: ${STATE_AGE_HOURS}h old — may be stale)"
    else
      echo "### Saved State"
    fi
    echo "Restored from previous session — resume from here, no need to re-read the file:"
    echo ""
    cat "$STATE_DIR/assistant-state.md"
    echo ""
  fi
fi

# Daemon status
if [ "$DAEMON_RUNNING" = "true" ]; then
  echo "### Daemon"
  echo "CC4Me daemon is running (port 3847). Transcript watching, Telegram, email, and scheduled tasks are managed by the daemon."
else
  echo "### Daemon"
  echo "CC4Me daemon is NOT running. Using fallback v1 transcript watcher. Start daemon: \`launchctl load ~/Library/LaunchAgents/com.assistant.daemon.plist\`"
fi
echo ""

echo "---"

# --- Auto-resume: inject a bootstrap prompt via tmux ---
# Triggers the agent to self-load context (todos, calendar, memory) via its own skills,
# instead of the hook parsing JSON in bash. Works for all session start types.
if [ "${CC4ME_QUIET_START:-0}" != "1" ]; then
  TMUX_BIN="/opt/homebrew/bin/tmux"
  TMUX_SOCKET="/private/tmp/tmux-$(id -u)/default"
  SESSION_NAME=$(grep -A1 '^tmux:' "$PROJECT_DIR/cc4me.config.yaml" 2>/dev/null | grep 'session:' | sed 's/.*session:[[:space:]]*//' | tr -d '"' | tr -d "'")
  SESSION_NAME="${SESSION_NAME:-cc4me}"

  if [ "$SOURCE" = "clear" ] || [ "$SOURCE" = "compact" ]; then
    PROMPT="Session cleared and restored. Pick up where you left off."
  else
    PROMPT="Session auto-started. Check todos, calendar, and any saved state. Work on pending tasks autonomously."
  fi

  # Spawn a detached background job that waits for the session to initialize,
  # then injects a prompt. nohup + disown ensures it survives hook exit.
  nohup bash -c "
    sleep 4
    $TMUX_BIN -S '$TMUX_SOCKET' send-keys -t '$SESSION_NAME' -l '$PROMPT'
    sleep 0.1
    $TMUX_BIN -S '$TMUX_SOCKET' send-keys -t '$SESSION_NAME' Enter
  " >/dev/null 2>&1 &
  disown
fi

exit 0
