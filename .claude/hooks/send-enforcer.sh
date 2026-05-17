#!/bin/sh
# Stop-event hook: enforce that non-terminal channel replies use POST /api/send.
#
# When the active channel is non-terminal AND the turn produced assistant text,
# the turn MUST contain a Bash tool call posting to localhost:3847/api/send.
#
# Current rollout: WARN-ONLY (no hard block). After 48h soak, switch to exit 2.
#
# Env vars set by Claude Code for Stop hooks:
#   CLAUDE_PROJECT_DIR — project root
#   CLAUDE_SESSION_ID  — session identifier (may be absent in older versions)
# The hook payload arrives on stdin as JSON with at least:
#   { "transcript_path": "...", "hook_event_name": "Stop", ... }

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
CHANNEL_FILE="$PROJECT_DIR/.claude/state/channel.txt"
LOG_FILE="$PROJECT_DIR/logs/send-enforcer.log"

# ── 0. Session scope guard ────────────────────────────────────────────────────
# Only enforce for the comms session. Workers, orchestrators, and any other
# Claude Code sessions bypass this hook entirely. This prevents false warnings
# from coding workers or test sessions that legitimately don't call /api/send.
#
# The comms session ID is written by session-start.sh at bootstrap time.
# Known limitation: on first boot before session-start.sh has run, the file
# won't exist and enforcement is skipped (fail-open for back-compat). This is
# acceptable because Dave's machine runs exactly one persistent comms session.
COMMS_SESSION_FILE="$PROJECT_DIR/.claude/state/comms-session.txt"
if [ -f "$COMMS_SESSION_FILE" ]; then
  COMMS_SESSION_ID=$(cat "$COMMS_SESSION_FILE" | tr -d '[:space:]')
  if [ "${CLAUDE_SESSION_ID:-}" != "$COMMS_SESSION_ID" ]; then
    # Different session — skip enforcement silently
    exit 0
  fi
else
  # comms-session.txt not found — fail-open; log for visibility
  printf 'DEBUG send-enforcer: comms-session.txt not found at %s — skipping session guard\n' \
    "$COMMS_SESSION_FILE" >> "$LOG_FILE" 2>/dev/null || true
  exit 0
fi

# ── 1. Check channel ──────────────────────────────────────────────────────────
CHANNEL=""
if [ -f "$CHANNEL_FILE" ]; then
  CHANNEL=$(cat "$CHANNEL_FILE" | tr -d '[:space:]')
fi

# Exit immediately if channel is empty, missing, or terminal
if [ -z "$CHANNEL" ] || [ "$CHANNEL" = "terminal" ]; then
  exit 0
fi

# ── 2. Read payload and extract transcript path ───────────────────────────────
PAYLOAD=$(cat)

TRANSCRIPT_PATH=$(printf '%s' "$PAYLOAD" | python3 -c "
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

# ── 3. Sleep briefly to let transcript flush ──────────────────────────────────
sleep 0.5

# ── 4. Check if the last assistant turn produced any visible text ─────────────
# Transcript is JSONL; we need the last line with role=="assistant" and check
# whether its content array has any {type:"text"} entry with non-empty text.
HAS_TEXT=$(python3 - "$TRANSCRIPT_PATH" <<'PYEOF'
import sys, json

path = sys.argv[1]
last_assistant = None

try:
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get('role') == 'assistant':
                last_assistant = msg
except Exception:
    pass

if last_assistant is None:
    print('no')
    sys.exit(0)

content = last_assistant.get('content', [])
if isinstance(content, str):
    # Rare: plain string content
    print('yes' if content.strip() else 'no')
    sys.exit(0)

if not isinstance(content, list):
    print('no')
    sys.exit(0)

for item in content:
    if isinstance(item, dict) and item.get('type') == 'text':
        text = item.get('text', '')
        if text and text.strip():
            print('yes')
            sys.exit(0)

print('no')
PYEOF
)

# If the turn produced no assistant text, nothing to enforce
if [ "$HAS_TEXT" != "yes" ]; then
  exit 0
fi

# ── 5. Scan the same turn for a Bash call to /api/send ───────────────────────
HAS_SEND=$(python3 - "$TRANSCRIPT_PATH" <<'PYEOF'
import sys, json, re

path = sys.argv[1]
last_assistant = None

try:
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get('role') == 'assistant':
                last_assistant = msg
except Exception:
    pass

if last_assistant is None:
    print('no')
    sys.exit(0)

content = last_assistant.get('content', [])
if not isinstance(content, list):
    print('no')
    sys.exit(0)

# Pattern: localhost:3847/api/send (with optional trailing chars, query strings, etc.)
pattern = re.compile(r'localhost:3847/api/send')

for item in content:
    if not isinstance(item, dict):
        continue
    if item.get('type') != 'tool_use':
        continue
    if item.get('name') != 'Bash':
        continue
    inp = item.get('input', {})
    command = inp.get('command', '') if isinstance(inp, dict) else ''
    if pattern.search(command):
        print('yes')
        sys.exit(0)

print('no')
PYEOF
)

# ── 6. Evaluate result ────────────────────────────────────────────────────────
if [ "$HAS_SEND" = "yes" ]; then
  exit 0
fi

# Warn-only: write to stderr and log — do NOT exit 2 during initial rollout
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"

printf 'Reply Delivery Rule: channel=%s but no /api/send call found. The reply may not have reached the human.\n' "$CHANNEL" >&2

# Append to log (create logs dir if needed)
LOG_DIR=$(dirname "$LOG_FILE")
mkdir -p "$LOG_DIR" 2>/dev/null
printf '%s channel=%s session=%s transcript=%s\n' \
  "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  "$CHANNEL" \
  "$SESSION_ID" \
  "$TRANSCRIPT_PATH" \
  >> "$LOG_FILE" 2>/dev/null

exit 0
