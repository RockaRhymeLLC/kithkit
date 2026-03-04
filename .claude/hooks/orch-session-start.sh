#!/bin/bash
# Orchestrator session-start hook
# Loaded by Claude Code on session start (via .claude/settings.json hooks)
set -euo pipefail

DAEMON_PORT=${DAEMON_PORT:-3847}

echo "=== Orchestrator Session Start ==="
echo ""

# Load saved state if available
STATE_FILE=".claude/state/orchestrator-state.md"
if [ -f "$STATE_FILE" ]; then
  AGE_MIN=$(( ($(date +%s) - $(stat -f%m "$STATE_FILE")) / 60 ))
  echo "Previous state saved ${AGE_MIN} minutes ago:"
  echo "---"
  head -50 "$STATE_FILE"
  echo "---"
  echo ""
fi

# Query pending tasks
TASKS=$(curl -sf "http://localhost:$DAEMON_PORT/api/orchestrator/tasks?status=pending,assigned,in_progress" 2>/dev/null || echo '{"data":[]}')
TASK_COUNT=$(echo "$TASKS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null || echo 0)

echo "Tasks in queue: $TASK_COUNT"
if [ "$TASK_COUNT" -gt "0" ]; then
  echo ""
  echo "$TASKS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in d.get('data', []):
    print(f\"  [{t['status']}] {t['id'][:8]}... {t['title'][:80]}\")
" 2>/dev/null || true
fi

# Check for unread messages
MSGS=$(curl -sf "http://localhost:$DAEMON_PORT/api/messages?agent=orchestrator&unread=true" 2>/dev/null || echo '{"data":[]}')
MSG_COUNT=$(echo "$MSGS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null || echo 0)

if [ "$MSG_COUNT" -gt "0" ]; then
  echo ""
  echo "Unread messages: $MSG_COUNT"
fi

echo ""
echo "Use /orchestrator-sop for task lifecycle procedures."
