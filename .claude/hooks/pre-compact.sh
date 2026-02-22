#!/bin/bash
#
# PreCompact Hook
#
# Backs up assistant-state.md and instructs Claude to save context
# before compaction erases conversation history.
#
# Key insight: Claude has the context, this hook doesn't.
# We output an instruction that tells Claude to save its own state.
#
# Fires on: manual (/compact), auto (context full)

set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="$PROJECT_DIR/.claude/state"

# Read input from stdin (required by hook protocol)
INPUT=$(cat)

# Backup current assistant-state.md if it exists
if [ -f "$STATE_DIR/assistant-state.md" ]; then
  BACKUP_DIR="$STATE_DIR/assistant-state-backups"
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  cp "$STATE_DIR/assistant-state.md" "$BACKUP_DIR/assistant-state-$TIMESTAMP.md"

  # Keep only the 5 most recent backups
  ls -t "$BACKUP_DIR"/assistant-state-*.md 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null

  # Append current state to 24hr log if the script exists
  if [ -x "$PROJECT_DIR/scripts/append-state-log.sh" ]; then
    "$PROJECT_DIR/scripts/append-state-log.sh" --force "Pre-compact backup"
  fi
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

exit 0
