#!/bin/bash
#
# PreToolUse Hook: Pre-Build Validation
#
# Runs before Bash tool calls. Since this is registered as a PreToolUse
# hook matching ALL Bash invocations, we must detect whether we're in an
# active /build context before doing any work.
#
# The /build skill should create a flag file at /tmp/kithkit-build-active
# containing the plan file path to signal that pre-build checks should run.
# Without the flag, this hook exits immediately (no overhead on normal
# Bash commands).
#
# Exit code 0: Proceed (or not a build context)
# Exit code 1: Block build

BUILD_FLAG="/tmp/kithkit-build-active"

# Early exit: only run pre-build checks when the build skill is active
if [ ! -f "$BUILD_FLAG" ]; then
  exit 0
fi

# Read the plan file path from the flag, then consume it
PLAN_FILE="$(cat "$BUILD_FLAG" 2>/dev/null || true)"
rm -f "$BUILD_FLAG"

echo "Running pre-build checks..."
echo ""

# Fallback: try to get it from command arguments
if [ -z "$PLAN_FILE" ]; then
  PLAN_FILE="$1"
fi

if [ -z "$PLAN_FILE" ]; then
  echo "Error: No plan file specified"
  echo "Usage: /build <plan-file-path>"
  exit 1
fi

# Check if plan file exists
if [ ! -f "$PLAN_FILE" ]; then
  echo "Error: Plan file not found: $PLAN_FILE"
  exit 1
fi

echo "Plan file found: $PLAN_FILE"

# Extract spec file path from plan
SPEC_FILE=$(grep -E "Spec.*:" "$PLAN_FILE" | grep -oE "specs/[^ )\"']+" | head -1)

if [ -z "$SPEC_FILE" ]; then
  echo "Error: Could not find spec file reference in plan"
  exit 1
fi

# Check if spec file exists
if [ ! -f "$SPEC_FILE" ]; then
  echo "Error: Referenced spec file not found: $SPEC_FILE"
  exit 1
fi

echo "Spec file found: $SPEC_FILE"
echo ""
echo "Pre-build checks passed. Claude will validate content during build."
echo ""

exit 0
