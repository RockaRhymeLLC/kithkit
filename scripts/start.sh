#!/bin/bash

# Kithkit Startup Script
#
# Launches Claude Code with the custom system prompt.
# Used by both manual startup and launchd service.

set -e

# Source shared config
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

# Find claude binary - check known install location first, then PATH
if [ -x "$HOME/.local/bin/claude" ]; then
    CLAUDE="$HOME/.local/bin/claude"
elif command -v claude >/dev/null 2>&1; then
    CLAUDE="$(command -v claude)"
else
    echo "Error: claude not found. Install Claude Code first." >&2
    exit 1
fi

# Change to project directory
cd "$BASE_DIR"

# System prompt file location
SYSTEM_PROMPT_FILE=".claude/state/system-prompt.txt"

# Build arguments array
ARGS=()

# Add system prompt if it exists
if [ -f "$SYSTEM_PROMPT_FILE" ]; then
    ARGS+=("--append-system-prompt" "$(cat "$SYSTEM_PROMPT_FILE")")
fi

# Add any additional arguments passed to this script
ARGS+=("$@")

# Execute claude with proper argument handling
exec "$CLAUDE" "${ARGS[@]}"
