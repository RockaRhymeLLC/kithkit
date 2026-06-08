#!/bin/sh
# Shell-level fixture tests for .claude/hooks/send-enforcer.sh
#
# Usage:
#   bash daemon/src/__tests__/send-enforcer.test.sh
#
# Exits 0 if all tests pass, non-zero on any failure.
# Tests are self-contained — no daemon or filesystem state required.

set -eu

HOOK="$(cd "$(dirname "$0")/../../.." && pwd)/.claude/hooks/send-enforcer.sh"

if [ ! -f "$HOOK" ]; then
  printf 'ERROR: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

PASS=0
FAIL=0

# ── Helpers ───────────────────────────────────────────────────────────────────

# run_test NAME CHANNEL TRANSCRIPT_JSON EXPECT_WARN
# EXPECT_WARN: "yes" or "no"
run_test() {
  TEST_NAME="$1"
  CHANNEL="$2"
  TRANSCRIPT_JSON="$3"
  EXPECT_WARN="$4"

  # Build temporary state
  TMPDIR=$(mktemp -d /tmp/send-enforcer-test.XXXXXX)
  trap 'rm -rf "$TMPDIR"' EXIT INT TERM

  # Set up channel file (empty string = missing channel, "terminal" = bypass)
  mkdir -p "$TMPDIR/.claude/state"
  if [ -n "$CHANNEL" ]; then
    printf '%s' "$CHANNEL" > "$TMPDIR/.claude/state/channel.txt"
  fi

  # Write comms-session.txt so the session-scope guard in the hook allows
  # enforcement to proceed. CLAUDE_SESSION_ID must match this value (passed
  # via env below). Without this, the hook exits 0 (fail-open) for all tests.
  TEST_SESSION_ID="test-session-enforcer-abc123"
  printf '%s' "$TEST_SESSION_ID" > "$TMPDIR/.claude/state/comms-session.txt"

  # Write transcript JSONL
  TRANSCRIPT_FILE="$TMPDIR/transcript.jsonl"
  printf '%s\n' "$TRANSCRIPT_JSON" > "$TRANSCRIPT_FILE"

  # Build the hook payload (mirrors what Claude Code sends on stdin)
  PAYLOAD=$(printf '{"transcript_path":"%s","hook_event_name":"Stop"}' "$TRANSCRIPT_FILE")

  # Run the hook; capture stderr (where warnings go); suppress stdout.
  # Use env(1) to pass CLAUDE_PROJECT_DIR and CLAUDE_SESSION_ID to sh — a bare
  # VAR=val before a pipeline only applies to the first command (printf), not
  # to sh "$HOOK".
  STDERR_OUT=$(printf '%s' "$PAYLOAD" \
    | env CLAUDE_PROJECT_DIR="$TMPDIR" CLAUDE_SESSION_ID="$TEST_SESSION_ID" sh "$HOOK" 2>&1 >/dev/null || true)

  HOOK_EXIT=$?

  # Check for "Reply Delivery Rule" in stderr
  if printf '%s' "$STDERR_OUT" | grep -q "Reply Delivery Rule"; then
    GOT_WARN="yes"
  else
    GOT_WARN="no"
  fi

  if [ "$GOT_WARN" = "$EXPECT_WARN" ] && [ "$HOOK_EXIT" = "0" ]; then
    printf '[PASS] %s\n' "$TEST_NAME"
    PASS=$((PASS + 1))
  else
    printf '[FAIL] %s\n' "$TEST_NAME"
    printf '       expected warn=%s got warn=%s exit=%s\n' "$EXPECT_WARN" "$GOT_WARN" "$HOOK_EXIT"
    if [ -n "$STDERR_OUT" ]; then
      printf '       stderr: %s\n' "$STDERR_OUT"
    fi
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$TMPDIR"
  trap - EXIT INT TERM
}

# ── Fixture transcripts ───────────────────────────────────────────────────────

# Minimal assistant message with text content
TRANSCRIPT_TEXT_ONLY='{"role":"assistant","content":[{"type":"text","text":"Hello from the comms agent."}]}'

# Assistant message with text + a Bash tool call posting to /api/send
TRANSCRIPT_WITH_SEND='{"role":"assistant","content":[{"type":"text","text":"Sending reply via channel router."},{"type":"tool_use","name":"Bash","input":{"command":"curl -s -X POST http://localhost:3847/api/send -H \"Content-Type: application/json\" -d \"{}\""}}]}'

# Assistant message with text + a Bash tool call that does NOT post to /api/send
TRANSCRIPT_WITHOUT_SEND='{"role":"assistant","content":[{"type":"text","text":"Here is my answer."},{"type":"tool_use","name":"Bash","input":{"command":"echo hello"}}]}'

# ── Tests ─────────────────────────────────────────────────────────────────────

# Test 1: channel=terminal → no warning (bypass)
run_test \
  "channel=terminal bypasses enforcement" \
  "terminal" \
  "$TRANSCRIPT_TEXT_ONLY" \
  "no"

# Test 2: channel=telegram + transcript with /api/send call → no warning
run_test \
  "channel=telegram with /api/send call passes" \
  "telegram" \
  "$TRANSCRIPT_WITH_SEND" \
  "no"

# Test 3: channel=telegram + transcript without /api/send call → warning emitted
run_test \
  "channel=telegram without /api/send call emits warning" \
  "telegram" \
  "$TRANSCRIPT_WITHOUT_SEND" \
  "yes"

# Test 4: channel=telegram + text-only reply (no tool calls at all) → warning
# Primary failure mode: comms responds with text but never calls /api/send.
# No tool_use blocks means HAS_SEND will be "no" → warning must fire.
run_test \
  "channel=telegram with text-only reply (no tool calls) emits warning" \
  "telegram" \
  "$TRANSCRIPT_TEXT_ONLY" \
  "yes"

# Test 5 (minor #5): channel=voice + text-only reply → warning
run_test \
  "channel=voice with text-only reply emits warning" \
  "voice" \
  "$TRANSCRIPT_TEXT_ONLY" \
  "yes"

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
