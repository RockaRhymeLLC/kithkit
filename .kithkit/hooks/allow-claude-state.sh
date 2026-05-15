#!/usr/bin/env bash
# allow-claude-state.sh — Auto-allows Write/Edit tool calls targeting .kithkit/state/ paths.
#
# Bypasses the protected-directory permission prompt (introduced in Claude Code v2.1.78)
# for paths under .kithkit/state/, which is a kithkit-managed directory.
#
# Only .kithkit/state/ is allowed — NOT all of .kithkit/. Other paths (settings.json,
# CLAUDE.md, hooks/, agents/, etc.) continue through normal permission handling.
#
# Hook protocol: output allow JSON to stdout to permit, exit 0 with no output to pass through.

set -euo pipefail

# Read full stdin
INPUT=""
if [[ -p /dev/stdin ]]; then
  INPUT=$(cat)
fi

# Nothing on stdin — pass through
if [[ -z "$INPUT" ]]; then
  exit 0
fi

# Parse tool_name and file_path using jq
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

# Only act on Write or Edit tool calls (defensive — matcher in settings.json already filters)
if [[ "$TOOL_NAME" != "Write" && "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

# No file_path — pass through
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Strict check: path must contain /.kithkit/state/ as a literal substring.
# This will NOT match .kithkit/settings.json, .kithkit/CLAUDE.md, .kithkit/hooks/, etc.
if [[ "$FILE_PATH" == *"/.kithkit/state/"* ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-allowed: .kithkit/state/ is a kithkit managed directory"}}'
  exit 0
fi

# Path does not match — pass through to normal handling
exit 0
