#!/bin/bash
# Hook script for PostToolUse + Stop + SubagentStop events.
# Notifies the daemon that there's a new assistant message to read
# from the transcript.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Read payload from stdin
PAYLOAD=$(cat)

# Extract transcript_path from payload if available
TRANSCRIPT_PATH=$(echo "$PAYLOAD" | grep -o '"transcript_path":"[^"]*"' | head -1 | cut -d'"' -f4)

# Extract hook_event_name from payload (e.g., "Stop", "SubagentStop", "PostToolUse")
HOOK_EVENT=$(echo "$PAYLOAD" | grep -o '"hook_event_name":"[^"]*"' | head -1 | cut -d'"' -f4)

# Build the JSON body
BODY="{}"
if [ -n "$TRANSCRIPT_PATH" ] && [ -n "$HOOK_EVENT" ]; then
  BODY="{\"transcript_path\":\"$TRANSCRIPT_PATH\",\"hook_event\":\"$HOOK_EVENT\"}"
elif [ -n "$TRANSCRIPT_PATH" ]; then
  BODY="{\"transcript_path\":\"$TRANSCRIPT_PATH\"}"
elif [ -n "$HOOK_EVENT" ]; then
  BODY="{\"hook_event\":\"$HOOK_EVENT\"}"
fi

# Notify daemon — fire-and-forget, backgrounded to avoid hook timeout.
curl -s -X POST "http://localhost:3847/hook/response" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  --max-time 2 >/dev/null 2>&1 &
