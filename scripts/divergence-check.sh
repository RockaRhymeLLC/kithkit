#!/usr/bin/env bash
<<<<<<< HEAD
# divergence-check.sh — Bash wrapper for divergence-check.ts
#
# Compiles the TypeScript script if needed, then runs it with node.
# Passes all CLI args through to the TypeScript script.
#
# Usage:
#   bash scripts/divergence-check.sh [--json]
=======
# divergence-check.sh — shell wrapper for divergence-check.ts
# Called by .github/workflows/upstream-sync.yml
#
# Usage: bash scripts/divergence-check.sh [--json]
>>>>>>> upstream/main

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
<<<<<<< HEAD
TS_SCRIPT="$SCRIPT_DIR/divergence-check.ts"
COMPILED_OUT="$SCRIPT_DIR/dist/divergence-check.mjs"

# ── Try tsx (fastest path — no compile step) ──────────────────
if command -v tsx &>/dev/null; then
  exec tsx "$TS_SCRIPT" "$@"
fi

# ── Try npx tsx ───────────────────────────────────────────────
if [ -f "$PROJECT_DIR/node_modules/.bin/tsx" ]; then
  exec "$PROJECT_DIR/node_modules/.bin/tsx" "$TS_SCRIPT" "$@"
fi

if [ -f "$PROJECT_DIR/daemon/node_modules/.bin/tsx" ]; then
  exec "$PROJECT_DIR/daemon/node_modules/.bin/tsx" "$TS_SCRIPT" "$@"
fi

# ── Compile with tsc, then run ────────────────────────────────
mkdir -p "$SCRIPT_DIR/dist"

TSC=""
if command -v tsc &>/dev/null; then
  TSC="tsc"
elif [ -f "$PROJECT_DIR/node_modules/.bin/tsc" ]; then
  TSC="$PROJECT_DIR/node_modules/.bin/tsc"
elif [ -f "$PROJECT_DIR/daemon/node_modules/.bin/tsc" ]; then
  TSC="$PROJECT_DIR/daemon/node_modules/.bin/tsc"
fi

if [ -n "$TSC" ]; then
  # Compile standalone — use project tsconfig but override outDir
  $TSC \
    --target ES2022 \
    --module NodeNext \
    --moduleResolution NodeNext \
    --outDir "$SCRIPT_DIR/dist" \
    --noEmit false \
    --declaration false \
    "$TS_SCRIPT" 2>/dev/null || true
fi

# ── Run compiled output if it exists ─────────────────────────
if [ -f "$COMPILED_OUT" ]; then
  exec node "$COMPILED_OUT" "$@"
fi

# Fallback: try node with --loader ts-node/esm
if node --input-type=module --eval "import '$TS_SCRIPT'" 2>/dev/null; then
  exec node --loader ts-node/esm "$TS_SCRIPT" "$@"
fi

echo "Error: could not find tsx, tsc, or ts-node to run divergence-check.ts" >&2
echo "Install tsx: npm install -g tsx" >&2
exit 1
=======

exec npx tsx "$SCRIPT_DIR/divergence-check.ts" "$@"
>>>>>>> upstream/main
