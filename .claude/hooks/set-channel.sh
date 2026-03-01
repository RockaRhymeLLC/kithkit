#!/bin/bash
#
# UserPromptSubmit Hook: Auto-detect channel from message source
# Sets channel to "telegram" if message has [Telegram] prefix, otherwise "terminal"
# Preserves "-verbose" suffix if already set (e.g., telegram-verbose stays verbose)
# Preserves current channel for auto-injected prompts (session restore, hooks, etc.)

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHANNEL_FILE="$BASE_DIR/.claude/state/channel.txt"

# Read current channel to check for verbose mode
CURRENT=""
if [ -f "$CHANNEL_FILE" ]; then
  CURRENT=$(cat "$CHANNEL_FILE" | tr -d '[:space:]')
fi

# Read the prompt from stdin
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | /usr/bin/jq -r '.prompt // empty')

if [[ "$PROMPT" == "[Agent]"* ]] || [[ "$PROMPT" == "[Network]"* ]]; then
  # Agent-to-agent messages: set to terminal so responses don't forward to Telegram
  echo "terminal" > "$CHANNEL_FILE"
elif [[ "$PROMPT" == "[Telegram]"* ]] || [[ "$PROMPT" == "[3rdParty][Telegram]"* ]] || [[ "$PROMPT" == "[Voice]"* ]]; then
  # Keep verbose if already in verbose mode
  if [ "$CURRENT" = "telegram-verbose" ]; then
    echo "telegram-verbose" > "$CHANNEL_FILE"
  else
    echo "telegram" > "$CHANNEL_FILE"
  fi
elif [[ "$PROMPT" == "Session cleared"* ]] || \
     [[ "$PROMPT" == "Session auto-started"* ]] || \
     [[ "$PROMPT" == "/save-state"* ]] || \
     [[ "$PROMPT" == "/clear"* ]] || \
     [[ "$PROMPT" == "/restart"* ]] || \
     [[ -z "$PROMPT" ]]; then
  # Auto-injected system prompts — preserve current channel
  # Don't reset to terminal just because a hook/watchdog triggered a prompt
  :
else
  echo "terminal" > "$CHANNEL_FILE"
fi

# Opportunistic backup notification — the previous turn's response
# should be in the transcript by now. Background so it doesn't block.
curl -s -X POST "http://localhost:3847/hook/response" \
  -H "Content-Type: application/json" \
  -d '{"hook_event":"UserPromptSubmit"}' \
  --max-time 2 >/dev/null 2>&1 &

exit 0
