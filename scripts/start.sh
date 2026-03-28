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

# Identity file: config > legacy fallback
IDENTITY_FILE="$(read_config '.agent.identity_file' '')"
if [ -z "$IDENTITY_FILE" ]; then
    # Legacy fallback for older installations
    IDENTITY_FILE=".kithkit/state/system-prompt.txt"
fi

# Build arguments array
ARGS=()

# Permission mode: config-driven bypass (survives reboots)
SKIP_PERMS=$(read_config '.claude.skip_permissions' 'false')
if [ "$SKIP_PERMS" = "true" ]; then
    ARGS+=("--dangerously-skip-permissions")
fi

# Fallback: state file from previous --skip-permissions invocation
if [ -f "$STATE_DIR/skip-permissions" ]; then
    # Only add if not already added from config
    if [ "$SKIP_PERMS" != "true" ]; then
        ARGS+=("--dangerously-skip-permissions")
    fi
fi

# Add system prompt if identity file exists
if [ -f "$IDENTITY_FILE" ]; then
    ARGS+=("--append-system-prompt" "$(cat "$IDENTITY_FILE")")
fi

# Add any additional arguments passed to this script
ARGS+=("$@")

# Execute claude with proper argument handling
exec "$CLAUDE" "${ARGS[@]}"
