#!/bin/bash
#
# UserPromptSubmit Hook: Auto-detect channel from message source
#
# Logic:
#   [Telegram] or [Voice] → set channel to "telegram"
#   [3rdParty][Telegram]  → also telegram (contains "[Telegram]")
#   Any other [Tag] prefix → preserve current channel (system, agent, browser, etc.)
#   Session/slash prefixes → preserve current channel
#   Empty prompt           → preserve current channel
#   Everything else        → "terminal" (human typed in terminal)
#
# Preserves "-verbose" suffix if already set.

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHANNEL_FILE="$BASE_DIR/.kithkit/state/channel.txt"

# Ensure state directory exists
mkdir -p "$(dirname "$CHANNEL_FILE")"

# Read current channel to check for verbose mode
CURRENT=""
if [ -f "$CHANNEL_FILE" ]; then
  CURRENT=$(cat "$CHANNEL_FILE" | tr -d '[:space:]')
fi

# Read the prompt from stdin
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | /usr/bin/jq -r '.prompt // empty')

if [[ "$PROMPT" == *"[Telegram]"* ]] || [[ "$PROMPT" == "[Voice]"* ]]; then
  # Telegram or Voice input → set channel to telegram
  # *[Telegram]* catches both "[Telegram] User: hi" and "[3rdParty][Telegram] Someone: hi"
  if [ "$CURRENT" = "telegram-verbose" ]; then
    echo "telegram-verbose" > "$CHANNEL_FILE"
  else
    echo "telegram" > "$CHANNEL_FILE"
  fi
elif [[ "$PROMPT" == "["*"]"* ]] || \
     [[ "$PROMPT" == "Session cleared"* ]] || \
     [[ "$PROMPT" == "Session auto-started"* ]] || \
     [[ "$PROMPT" == "/save-state"* ]] || \
     [[ "$PROMPT" == "/clear"* ]] || \
     [[ "$PROMPT" == "/restart"* ]] || \
     [[ -z "$PROMPT" ]]; then
  # Any [Tag] prefixed prompt (e.g., [System], [Agent], [Browser]) → preserve channel
  # Also preserve on session lifecycle prompts and slash commands
  :
else
  echo "terminal" > "$CHANNEL_FILE"
fi

exit 0
