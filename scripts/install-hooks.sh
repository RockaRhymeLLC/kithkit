#!/usr/bin/env bash
# install-hooks.sh — Install git hooks for kithkit development
#
# Run this script once after cloning the repo to install local git hooks.
# Usage: bash scripts/install-hooks.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="${REPO_ROOT}/.git/hooks"

if [ ! -d "${HOOKS_DIR}" ]; then
  echo "ERROR: .git/hooks directory not found. Are you in a git repo?"
  exit 1
fi

# ── Pre-push hook ──────────────────────────────────────────────────────────────
# Runs the same secret leak check as CI before any push reaches GitHub.

PRE_PUSH_HOOK="${HOOKS_DIR}/pre-push"

cat > "${PRE_PUSH_HOOK}" << 'HOOK'
#!/usr/bin/env bash
# pre-push hook — secret leak check
# Mirrors the check in .github/workflows/ci.yml

set -euo pipefail

echo "[pre-push] Running secret leak check..."

# Get diff of commits being pushed vs remote
REMOTE="$1"
URL="$2"

DIFF=""
while IFS=' ' read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA; do
  if [ "${LOCAL_SHA}" = "0000000000000000000000000000000000000000" ]; then
    # Branch being deleted — skip
    continue
  fi
  if [ "${REMOTE_SHA}" = "0000000000000000000000000000000000000000" ]; then
    # New branch — diff from root
    DIFF="${DIFF}$(git diff HEAD 2>/dev/null || true)"
  else
    DIFF="${DIFF}$(git diff "${REMOTE_SHA}..${LOCAL_SHA}" 2>/dev/null || true)"
  fi
done

if [ -z "${DIFF}" ]; then
  echo "[pre-push] No diff to scan. OK."
  exit 0
fi

ADDED_LINES=$(echo "${DIFF}" | grep '^+' | grep -v '^+++')
FOUND=0

# API_KEY pattern
if echo "${ADDED_LINES}" | grep -iE 'API_KEY\s*[:=]\s*["\x27]?[A-Za-z0-9/+]{16,}' > /dev/null 2>&1; then
  echo "[pre-push] FAIL: Possible API key found in diff"
  FOUND=1
fi
# TOKEN pattern
if echo "${ADDED_LINES}" | grep -iE '\bTOKEN\s*[:=]\s*["\x27]?[A-Za-z0-9_\-]{16,}' | \
   grep -iv 'INSTANCE_SYNC_TOKEN\|example\|placeholder\|your-token\|<token>' > /dev/null 2>&1; then
  echo "[pre-push] FAIL: Possible token found in diff"
  FOUND=1
fi
# PASSWORD pattern
if echo "${ADDED_LINES}" | grep -iE 'PASSWORD\s*[:=]\s*["\x27]?[^\s]{8,}' | \
   grep -iv 'your-password\|placeholder\|example' > /dev/null 2>&1; then
  echo "[pre-push] FAIL: Possible password found in diff"
  FOUND=1
fi
# SECRET pattern
if echo "${ADDED_LINES}" | grep -iE '\bSECRET\s*[:=]\s*["\x27]?[A-Za-z0-9/+_\-]{16,}' | \
   grep -iv 'credential-\|INSTANCE_SYNC_TOKEN\|GITHUB_TOKEN\|secrets\.' > /dev/null 2>&1; then
  echo "[pre-push] FAIL: Possible secret value found in diff"
  FOUND=1
fi
# credential strings with apparent values
if echo "${ADDED_LINES}" | grep -iE "credential\s*[:=]\s*[\"'][A-Za-z0-9/+]{20,}" > /dev/null 2>&1; then
  echo "[pre-push] FAIL: Possible credential value found in diff"
  FOUND=1
fi

if [ "${FOUND}" -eq 1 ]; then
  echo ""
  echo "[pre-push] Secret leak check FAILED. Push aborted."
  echo "[pre-push] Review the patterns above before pushing."
  exit 1
else
  echo "[pre-push] Secret leak check PASSED."
fi
HOOK

chmod +x "${PRE_PUSH_HOOK}"
echo "Installed pre-push hook at ${PRE_PUSH_HOOK}"

echo ""
echo "All hooks installed. Run 'git push' to verify the pre-push hook fires."
