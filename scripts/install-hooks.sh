#!/bin/bash
# scripts/install-hooks.sh — installs git hooks for the kithkit public repo.
# Run once after cloning, or after updating hooks.
#
# Currently installs:
#   - pre-push: leak check for instance-specific content
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "Installing git hooks into $HOOKS_DIR..."

# --- pre-push hook: leak check ---
cat > "$HOOKS_DIR/pre-push" << 'HOOK'
#!/bin/bash
# pre-push hook — checks for instance-specific content before pushing.
# Same blocked patterns as .github/workflows/ci.yml leak-check job.
# Keep these lists in sync.
set -euo pipefail

BLOCKED_PATTERNS=(
  "BMO"
  "R2D2"
  "Skippy"
  "bmobot"
  "daveh@"
  "192\.168\.12"
  "credential-"
  "com\.assistant\.bmo"
  "com\.bmo\."
  "lindee"
  "kp\.hurley"
  "7629737488"
)

EXCLUSIONS="README\.md|SECURITY\.md|CONTRIBUTING\.md|templates/|\.github/"

PATTERN=$(IFS="|"; echo "${BLOCKED_PATTERNS[*]}")

# Check all tracked files (not just staged — pre-push checks the whole push)
MATCHES=$(git diff --name-only --diff-filter=ACMR HEAD @{push} 2>/dev/null | \
  grep -v -E "$EXCLUSIONS" | \
  xargs grep -lE "$PATTERN" 2>/dev/null || true)

if [ -n "$MATCHES" ]; then
  echo ""
  echo "LEAK CHECK FAILED — instance-specific patterns found in:"
  echo ""
  for f in $MATCHES; do
    echo "  $f"
    grep -nE "$PATTERN" "$f" | head -3 | sed 's/^/    /'
  done
  echo ""
  echo "Fix before pushing to the public repo."
  echo "See .github/workflows/ci.yml for the full pattern list."
  echo "If this is a false positive, add the file to EXCLUSIONS in this hook."
  exit 1
fi

echo "Leak check passed."
HOOK

chmod +x "$HOOKS_DIR/pre-push"
echo "  Installed: pre-push (leak check)"

echo "Done. All hooks installed."
