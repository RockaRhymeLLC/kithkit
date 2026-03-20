#!/bin/bash
# UserPromptSubmit Hook: Correction signal detector
#
# Scans incoming user prompts for correction signals and stores a learning
# immediately via the daemon memory API.
#
# Correction patterns detected (case-insensitive):
#   - "no, " / "no that" / "no the"
#   - "that is wrong" / "thats wrong" / "that was wrong" / "thats not right"
#   - "actually, " / "actually it is" / "actually the"
#   - "incorrect" / "not right" / "wrong"

export PATH="$HOME/.local/bin:$PATH"

DAEMON_URL="${KITHKIT_DAEMON_URL:-http://localhost:3847}"
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Read stdin (JSON from Claude Code hook) ────────────────────────────────
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | /usr/bin/jq -r '.prompt // empty' 2>/dev/null)

# Nothing to check if prompt is empty
if [ -z "$PROMPT" ]; then
  exit 0
fi

# ── Check for correction signal patterns ──────────────────────────────────
# Use grep -iE to match any of the patterns (case-insensitive)
CORRECTION_PATTERN='(^|[^a-z])(no, |no that|no the|that is wrong|thats wrong|that was wrong|thats not right|actually, |actually it is|actually the|incorrect|not right|wrong)'

if ! echo "$PROMPT" | grep -iqE "$CORRECTION_PATTERN"; then
  exit 0
fi

# ── Correction detected — check daemon is up ──────────────────────────────
if ! curl -sf "$DAEMON_URL/health" > /dev/null 2>&1; then
  exit 0
fi

# ── Read agent name from config ───────────────────────────────────────────
AGENT_NAME="skippy"
CONFIG_FILE="$BASE_DIR/kithkit.config.yaml"
if [ -f "$CONFIG_FILE" ]; then
  NAME_FROM_CONFIG=$(grep -A3 "^agent:" "$CONFIG_FILE" | grep "  name:" | sed 's/.*name: *//' | tr -d '[:space:]' | head -1)
  if [ -n "$NAME_FROM_CONFIG" ]; then
    AGENT_NAME="$NAME_FROM_CONFIG"
  fi
fi

# ── Store learning via daemon API ─────────────────────────────────────────
# Pass values as env vars to avoid shell quoting/injection issues
HOOK_PROMPT="$PROMPT" HOOK_AGENT="$AGENT_NAME" HOOK_DAEMON="$DAEMON_URL" \
python3 - <<'PYEOF'
import json, subprocess, sys, os

prompt = os.environ.get('HOOK_PROMPT', '')
agent  = os.environ.get('HOOK_AGENT', 'unknown')
daemon = os.environ.get('HOOK_DAEMON', 'http://localhost:3847')

# Truncate very long prompts to keep memory content focused
if len(prompt) > 500:
    prompt = prompt[:497] + "..."

body = json.dumps({
    "content": "[auto-detected correction - needs review] " + prompt,
    "category": "behavioral",
    "tags": ["correction", "human-sourced"],
    "trigger": "correction",
    "decay_policy": "evergreen",
    "importance": 1,
    "shareable": False,
    "origin_agent": agent,
    "dedup": True,
})

subprocess.run(
    ["curl", "-sf", "-X", "POST",
     f"{daemon}/api/memory/store",
     "-H", "Content-Type: application/json",
     "-d", body],
    capture_output=True,
    text=True,
    timeout=5,
)
sys.exit(0)
PYEOF

exit 0
