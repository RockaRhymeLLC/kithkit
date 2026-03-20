#!/bin/bash
# PostToolUse hook: periodic transcript review for self-improvement
#
# Fires every ACTION_THRESHOLD tool uses OR when TIME_THRESHOLD_SECS has elapsed
# since the last review — whichever condition is met first.
#
# State files (not sensitive — transient):
#   /tmp/kithkit-transcript-review-counter  — invocation count since last review
#   /tmp/kithkit-transcript-review-last     — unix timestamp of last review
#   /tmp/kithkit-transcript-review.lock     — prevents concurrent runs

export PATH="$HOME/.local/bin:$PATH"

COUNTER_FILE="/tmp/kithkit-transcript-review-counter"
LAST_FILE="/tmp/kithkit-transcript-review-last"
LOCK_FILE="/tmp/kithkit-transcript-review.lock"
DAEMON_URL="${KITHKIT_DAEMON_URL:-http://localhost:3847}"

ACTION_THRESHOLD=25
TIME_THRESHOLD_SECS=1800  # 30 minutes

# Read hook input early (contains transcript_path and other context)
INPUT=$(cat)

# ── Increment counter ─────────────────────────────────────────────────────────
COUNTER=0
if [ -f "$COUNTER_FILE" ]; then
  COUNTER=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
fi
COUNTER=$(( COUNTER + 1 ))
echo "$COUNTER" > "$COUNTER_FILE"

# ── Check time elapsed since last review ──────────────────────────────────────
NOW=$(date +%s)
LAST=0
if [ -f "$LAST_FILE" ]; then
  LAST=$(cat "$LAST_FILE" 2>/dev/null || echo 0)
fi
ELAPSED=$(( NOW - LAST ))

# Exit immediately if neither threshold is met
if [ "$COUNTER" -lt "$ACTION_THRESHOLD" ] && [ "$ELAPSED" -lt "$TIME_THRESHOLD_SECS" ]; then
  exit 0
fi

# Threshold met — reset state before doing any work
echo "0" > "$COUNTER_FILE"
echo "$NOW" > "$LAST_FILE"

# ── Verify daemon is reachable ────────────────────────────────────────────────
if ! curl -sf "$DAEMON_URL/health" > /dev/null 2>&1; then
  exit 0
fi

# Check self_improvement.enabled via stats endpoint — exit if disabled (kill switch)
SI_ENABLED=$(curl -sf "$DAEMON_URL/api/self-improvement/stats" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print('true' if data.get('enabled') else 'false')
except Exception:
    print('false')
" 2>/dev/null)

if [ "$SI_ENABLED" != "true" ]; then
  exit 0
fi

# ── Extract transcript path from hook input ───────────────────────────────────
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "
import sys, json, os
try:
    p = json.load(sys.stdin).get('transcript_path', '')
    print(os.path.expanduser(p))
except Exception:
    print('')
" 2>/dev/null)

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# ── Cross-platform file mtime ─────────────────────────────────────────────────
get_mtime() {
  local file="$1"
  # macOS uses -f %m; Linux uses -c %Y
  stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null || echo 0
}

# ── Acquire lock atomically (prevent concurrent runs) ─────────────────────────
# noclobber makes the redirect fail atomically if the file already exists
if ! (set -o noclobber; echo $$ > "$LOCK_FILE") 2>/dev/null; then
  # Lock exists — check if it's stale (older than 5 minutes)
  LOCK_AGE=$(( $(date +%s) - $(get_mtime "$LOCK_FILE") ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    exit 0
  fi
  # Stale lock — remove and retry once
  rm -f "$LOCK_FILE"
  if ! (set -o noclobber; echo $$ > "$LOCK_FILE") 2>/dev/null; then
    exit 0
  fi
fi
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Build prompt and spawn review worker via daemon ───────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_TEMPLATE="$SCRIPT_DIR/transcript-review-prompt.md"

if [ ! -f "$PROMPT_TEMPLATE" ]; then
  exit 0
fi

# Resolve agent name (from daemon /status, fallback to KITHKIT_AGENT_NAME env, fallback to "this agent")
AGENT_NAME="${KITHKIT_AGENT_NAME:-}"
if [ -z "$AGENT_NAME" ]; then
  AGENT_NAME=$(curl -sf "$DAEMON_URL/status" 2>/dev/null | python3 -c "
import sys, json
try:
    print(json.load(sys.stdin).get('name', ''))
except Exception:
    print('')
" 2>/dev/null)
fi
AGENT_NAME="${AGENT_NAME:-this agent}"

# Write a temp prompt file with the transcript path injected at the top,
# substituting the {{AGENT_NAME}} placeholder with the resolved agent name.
PROMPT_FILE=$(mktemp /tmp/kithkit-transcript-review-prompt.XXXXXX)
{
  echo "Transcript file to review: $TRANSCRIPT_PATH"
  echo ""
  sed "s/{{AGENT_NAME}}/$AGENT_NAME/g" "$PROMPT_TEMPLATE"
} > "$PROMPT_FILE"
trap 'rm -f "$LOCK_FILE" "$PROMPT_FILE"' EXIT

# Spawn via daemon API (fire-and-forget — returns immediately, tracked in /api/agents)
# This ensures cost accounting and respects max concurrent agent limits.
PROMPT_CONTENT=$(cat "$PROMPT_FILE")
PROMPT_CONTENT="$PROMPT_CONTENT" DAEMON_URL="$DAEMON_URL" python3 - <<'PYEOF'
import json, subprocess, os

prompt = os.environ.get('PROMPT_CONTENT', '')
daemon = os.environ.get('DAEMON_URL', 'http://localhost:3847')

body = json.dumps({
    "profile": "retro",
    "prompt": prompt,
    "description": "Periodic transcript review (self-improvement)",
})

subprocess.run(
    ["curl", "-sf", "-X", "POST",
     f"{daemon}/api/agents/spawn",
     "-H", "Content-Type: application/json",
     "-d", body],
    capture_output=True,
    text=True,
    timeout=5,
)
PYEOF

exit 0
