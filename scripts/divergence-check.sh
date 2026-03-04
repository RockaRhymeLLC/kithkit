#!/usr/bin/env bash
# divergence-check.sh — shell wrapper for divergence-check.ts
# Called by .github/workflows/upstream-sync.yml
#
# Usage: bash scripts/divergence-check.sh [--json]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

exec npx tsx "$SCRIPT_DIR/divergence-check.ts" "$@"
