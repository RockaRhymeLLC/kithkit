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

# Check self_improvement is enabled in config
SI_ENABLED=$(curl -sf "$DAEMON_URL/health" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print('true')
except Exception:
    print('false')
" 2>/dev/null)

if [ "$SI_ENABLED" != "true" ]; then
  # Daemon is up but we couldn't parse response — proceed anyway (daemon health confirmed above)
  : # no-op, continue
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

# ── Acquire lock (prevent concurrent runs) ────────────────────────────────────
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE") ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    exit 0
  fi
fi

touch "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Build prompt and spawn haiku review worker ────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_TEMPLATE="$SCRIPT_DIR/transcript-review-prompt.md"

if [ ! -f "$PROMPT_TEMPLATE" ]; then
  exit 0
fi

# Write a temp prompt file with the transcript path injected at the top
PROMPT_FILE=$(mktemp /tmp/kithkit-transcript-review-prompt.XXXXXX)
{
  echo "Transcript file to review: $TRANSCRIPT_PATH"
  echo ""
  cat "$PROMPT_TEMPLATE"
} > "$PROMPT_FILE"
trap 'rm -f "$LOCK_FILE" "$PROMPT_FILE"' EXIT

# Spawn from /tmp to avoid loading project hooks recursively
cd /tmp
claude -p --model haiku --allowedTools "Read,Grep,Bash" < "$PROMPT_FILE" > /dev/null 2>&1

exit 0
