#!/bin/bash
#
# PreCompact Hook
#
# Backs up state files and instructs Claude to save context
# before compaction erases conversation history.
#
# Detects agent role (comms vs orchestrator) and handles each:
#   - Comms: backs up assistant-state.md, instructs /save-state
#   - Orchestrator: backs up orchestrator-state.md, instructs state save + exit
#
# Key insight: Claude has the context, this hook doesn't.
# We output an instruction that tells Claude to save its own state.
#
# Fires on: manual (/compact), auto (context full)

set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="$PROJECT_DIR/.claude/state"
TMUX_BIN="/opt/homebrew/bin/tmux"

# Read input from stdin (required by hook protocol)
INPUT=$(cat)

# ── Detect agent role via tmux session ──────────────────────
AGENT_ROLE="comms"
if [ -n "$TMUX_PANE" ] && [ -x "$TMUX_BIN" ]; then
  CURRENT_SESSION=$($TMUX_BIN display-message -t "$TMUX_PANE" -p '#{session_name}' 2>/dev/null || true)
  # Get expected session name from config
  SESSION_NAME=$(grep -A1 '^tmux:' "$PROJECT_DIR/kithkit.config.yaml" 2>/dev/null | grep 'session:' | sed 's/.*session:[[:space:]]*//' | tr -d '"' | tr -d "'")
  SESSION_NAME="${SESSION_NAME:-cc4me}"

  if [ -n "$CURRENT_SESSION" ] && [ "$CURRENT_SESSION" = "${SESSION_NAME}-orch" ]; then
    AGENT_ROLE="orchestrator"
  fi
fi

# ── Trigger context watchdog immediately ───────────────────
# The watchdog polls on a fixed interval and can miss rapid context jumps.
# PreCompact fires at the exact moment of context pressure — trigger the
# watchdog now so threshold actions (warn, restart) fire promptly.
DAEMON_PORT="${KITHKIT_PORT:-3847}"
curl -s -X POST "http://localhost:$DAEMON_PORT/api/tasks/context-watchdog/run" \
  >/dev/null 2>&1 || true

# ── Handle based on role ────────────────────────────────────

if [ "$AGENT_ROLE" = "orchestrator" ]; then
  # Backup orchestrator-state.md if it exists
  if [ -f "$STATE_DIR/orchestrator-state.md" ]; then
    BACKUP_DIR="$STATE_DIR/orchestrator-state-backups"
    mkdir -p "$BACKUP_DIR"
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    cp "$STATE_DIR/orchestrator-state.md" "$BACKUP_DIR/orchestrator-state-$TIMESTAMP.md"
    # Keep only the 5 most recent backups
    ls -t "$BACKUP_DIR"/orchestrator-state-*.md 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
  fi

  # Notify comms directly from the hook (safety net — don't rely on LLM doing it)
  curl -s -X POST "http://localhost:$DAEMON_PORT/api/messages" \
    -H "Content-Type: application/json" \
    -d '{"from":"orchestrator","to":"comms","type":"result","body":"[orchestrator] Context compaction triggered. Instructing orchestrator to save state. Check git log for committed work if it goes silent after this."}' \
    >/dev/null 2>&1 || true

  # Output orchestrator-specific instructions
  cat << 'EOF'
CRITICAL: Context compaction is about to happen. You are the orchestrator and are about to lose most of your conversation context.

IMMEDIATELY save your state before compaction:

1. Write .claude/state/orchestrator-state.md with:
   - **Task**: What task you were escalated to handle
   - **Completed Steps**: What's done (stories, files changed, test results)
   - **In Progress**: What you were actively working on
   - **Next Steps**: Exactly what to pick up next (ordered priority list)
   - **Workers**: Any active/pending worker jobs and their status
   - **Key Context**: File paths, error messages, decisions, anything that would be lost
   - **Files Modified**: List of files created or changed with brief descriptions

2. Send a progress summary to comms:
   curl -s -X POST http://localhost:3847/api/messages -H "Content-Type: application/json" -d '{"from":"orchestrator","to":"comms","type":"result","body":"<progress summary — what is done, what remains>"}'

3. Then exit cleanly. The daemon will respawn a fresh orchestrator with your state file as context.

This is your last chance to preserve context. Be thorough — your replacement depends on this file.
EOF

else
  # Comms agent: existing behavior
  # Backup current assistant-state.md if it exists
  if [ -f "$STATE_DIR/assistant-state.md" ]; then
    BACKUP_DIR="$STATE_DIR/assistant-state-backups"
    mkdir -p "$BACKUP_DIR"
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    cp "$STATE_DIR/assistant-state.md" "$BACKUP_DIR/assistant-state-$TIMESTAMP.md"
    # Keep only the 5 most recent backups
    ls -t "$BACKUP_DIR"/assistant-state-*.md 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
  fi

  # Output instruction to Claude (this appears in Claude's context)
  cat << 'EOF'
CRITICAL: Context compaction is about to happen. You are about to lose most of your conversation context.

IMMEDIATELY write your current state to .claude/state/assistant-state.md with:
1. **Current Task**: What you're working on right now (be specific)
2. **Progress**: What you've completed so far (files changed, decisions made)
3. **Next Steps**: Exactly what to do next when you resume
4. **Key Context**: Any important details that would be lost (variable names, error messages, user preferences expressed in this session)
5. **Open Questions**: Anything you were uncertain about

Then check /todo list and update any in-progress todos.

This is your last chance to preserve context before compaction. Be thorough.
EOF
fi

exit 0
