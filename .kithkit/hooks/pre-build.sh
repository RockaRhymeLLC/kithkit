#!/bin/bash

# Pre-Build Hook
#
# Runs before the /build skill executes
# Does basic file existence checks - Claude handles deeper validation
#
# Exit code 0: Proceed with build
# Exit code 1: Block build

echo "Running pre-build checks..."
echo ""

# Find the plan file path from command arguments
PLAN_FILE="$1"

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
