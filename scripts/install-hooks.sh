#!/usr/bin/env bash
# scripts/install-hooks.sh — installs git hooks for the kithkit public repo.
# Run once after cloning, or after updating hooks.
#
# Currently installs:
#   - pre-push: leak check for instance-specific content
#
# Usage: bash scripts/install-hooks.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "${HOOKS_DIR}" ]; then
  echo "ERROR: .git/hooks directory not found. Are you in a git repo?"
  exit 1
fi

echo "Installing git hooks into $HOOKS_DIR..."

# --- pre-push hook: leak check ---
cat > "$HOOKS_DIR/pre-push" << 'HOOK'
#!/usr/bin/env bash
# pre-push hook — checks for instance-specific content before pushing.
# Same blocked patterns as .github/workflows/ci.yml leak-check job.
# Keep these lists in sync.
set -euo pipefail

echo "[pre-push] Running instance content leak check..."

# NOTE: "credential-" and "BMO" are excluded — they're framework patterns.
# credential- is the keychain naming convention; BMO references exist in
# existing framework code (channel-router, telegram adapter). Cleaning
# those up is tracked separately.
BLOCKED_PATTERNS=(
  "R2D2"
  "Skippy"
  "bmobot"
  "daveh@"
  "192\.168\.12"
  "com\.assistant\.bmo"
  "com\.bmo\."
  "lindee"
  "kp\.hurley"
  "7629737488"
)

EXCLUSIONS="README\.md|SECURITY\.md|CONTRIBUTING\.md|templates/|\.github/|\.claude/skills/|docs/|install-hooks\.sh"

PATTERN=$(IFS="|"; echo "${BLOCKED_PATTERNS[*]}")

REMOTE="$1"
URL="$2"

MATCHES=""
while IFS=' ' read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA; do
  if [ "${LOCAL_SHA}" = "0000000000000000000000000000000000000000" ]; then
    # Branch being deleted — skip
    continue
  fi

  if [ "${REMOTE_SHA}" = "0000000000000000000000000000000000000000" ]; then
    # New branch — check all tracked files
    FILES=$(git diff --name-only --diff-filter=ACMR HEAD 2>/dev/null || true)
  else
    # Existing branch — check only the diff
    FILES=$(git diff --name-only --diff-filter=ACMR "${REMOTE_SHA}..${LOCAL_SHA}" 2>/dev/null || true)
  fi

  if [ -z "$FILES" ]; then
    continue
  fi

  FILTERED=$(echo "$FILES" | grep -v -E "$EXCLUSIONS" || true)
  if [ -z "$FILTERED" ]; then
    continue
  fi

  while IFS= read -r f; do
    [ -f "$f" ] || continue
    HITS=$(grep -nE "$PATTERN" "$f" 2>/dev/null || true)
    if [ -n "$HITS" ]; then
      MATCHES="${MATCHES}${f}:\n${HITS}\n\n"
    fi
  done <<< "$FILTERED"
done

if [ -n "$MATCHES" ]; then
  echo ""
  echo "LEAK CHECK FAILED — instance-specific patterns found:"
  echo ""
  echo -e "$MATCHES"
  echo "Fix before pushing to the public repo."
  echo "See .github/workflows/ci.yml for the full pattern list."
  echo "If this is a false positive, add the file to EXCLUSIONS in this hook."
  exit 1
fi

echo "[pre-push] Leak check passed."
HOOK

chmod +x "$HOOKS_DIR/pre-push"
echo "  Installed: pre-push (leak check)"

echo ""
echo "Done. All hooks installed."
echo "Run 'git push' to verify the pre-push hook fires."
