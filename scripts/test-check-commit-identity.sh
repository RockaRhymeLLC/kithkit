#!/usr/bin/env bash
# test-check-commit-identity.sh — unit tests for check-commit-identity.sh.
#
# Creates a throwaway git repo in /tmp, makes commits with various identities,
# and verifies the detection script produces correct pass/fail results.
#
# Usage: bash scripts/test-check-commit-identity.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/check-commit-identity.sh"

WORK_DIR=$(mktemp -d /tmp/identity-test-XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cd "$WORK_DIR"
git init -q
git config user.email "baseline@test.example.com"
git config user.name "Test Baseline"
git commit -q --allow-empty -m "root"
ROOT=$(git rev-parse HEAD)

# ---------------------------------------------------------------------------
# Test 1: clean author + committer — must PASS
# ---------------------------------------------------------------------------
git -c user.email="real@example.com" -c user.name="Alice" \
  commit -q --allow-empty -m "clean commit"
T1_HEAD=$(git rev-parse HEAD)

if "$CHECK" "$ROOT" "$T1_HEAD" > /dev/null 2>&1; then
  pass "Test 1: clean email (real@example.com) passes"
else
  fail "Test 1: clean email should pass — script rejected it"
fi

T1_BASE=$T1_HEAD

# ---------------------------------------------------------------------------
# Test 2: .local author email — must FAIL
# ---------------------------------------------------------------------------
git -c user.email="foo@bar.local" -c user.name="Bob" \
  commit -q --allow-empty -m ".local author"
T2_HEAD=$(git rev-parse HEAD)

if "$CHECK" "$T1_BASE" "$T2_HEAD" > /dev/null 2>&1; then
  fail "Test 2: foo@bar.local author should fail — script let it through"
else
  pass "Test 2: .local author email (foo@bar.local) correctly rejected"
fi

T2_BASE=$T2_HEAD

# ---------------------------------------------------------------------------
# Test 3: .local committer with clean author — must FAIL (committer is checked)
# ---------------------------------------------------------------------------
git -c user.email="clean.author@example.com" -c user.name="Clean Author" \
  commit -q --allow-empty -m ".local committer" \
  --author="Clean Author <clean.author@example.com>"
# Amend to inject a .local committer without touching author
GIT_COMMITTER_EMAIL="committer@box.local" \
GIT_COMMITTER_NAME="Box Committer" \
  git commit -q --amend --no-edit --allow-empty
T3_HEAD=$(git rev-parse HEAD)

if "$CHECK" "$T2_BASE" "$T3_HEAD" > /dev/null 2>&1; then
  fail "Test 3: .local committer should fail — script let it through"
else
  pass "Test 3: .local committer (committer@box.local) with clean author correctly rejected"
fi

T3_BASE=$T3_HEAD

# ---------------------------------------------------------------------------
# Test 4: empty author email — must FAIL
# ---------------------------------------------------------------------------
GIT_AUTHOR_EMAIL="" GIT_AUTHOR_NAME="No Email" \
GIT_COMMITTER_EMAIL="" GIT_COMMITTER_NAME="No Email" \
  git commit -q --allow-empty -m "empty email" 2>/dev/null || true
T4_HEAD=$(git rev-parse HEAD)

if [[ "$T4_HEAD" == "$T3_BASE" ]]; then
  # git refused to create the commit (some git versions validate email)
  pass "Test 4: git refused empty email commit — identity guard redundantly safe"
else
  if "$CHECK" "$T3_BASE" "$T4_HEAD" > /dev/null 2>&1; then
    fail "Test 4: empty email should fail — script let it through"
  else
    pass "Test 4: empty email correctly rejected"
  fi
fi

T4_BASE=$(git rev-parse HEAD)

# ---------------------------------------------------------------------------
# Test 5: email containing 'local' but not .local TLD — must PASS
# ---------------------------------------------------------------------------
git -c user.email="dev@localmail.com" -c user.name="Dev Local" \
  commit -q --allow-empty -m "local in email but not TLD"
T5_HEAD=$(git rev-parse HEAD)

if "$CHECK" "$T4_BASE" "$T5_HEAD" > /dev/null 2>&1; then
  pass "Test 5: dev@localmail.com (contains 'local' but not .local TLD) correctly passes"
else
  fail "Test 5: dev@localmail.com should pass — script over-matched"
fi

# ---------------------------------------------------------------------------
# Test 6: .local mid-domain (non-terminal) — must PASS  (#1024 anchor guard)
# dev@host.local.com contains ".local" but it is NOT the TLD; the regex anchors
# with `$` so only ".local" at end-of-host matches.  Dropping the `$` anchor in
# check-commit-identity.sh would make this test FAIL (script rejects the address).
# ---------------------------------------------------------------------------
T5_BASE=$T5_HEAD

git -c user.email="dev@host.local.com" -c user.name="Dev MidLocal" \
  commit -q --allow-empty -m ".local mid-domain, not TLD"
T6_HEAD=$(git rev-parse HEAD)

if "$CHECK" "$T5_BASE" "$T6_HEAD" > /dev/null 2>&1; then
  pass "Test 6: dev@host.local.com (.local mid-domain) correctly passes"
else
  fail "Test 6: dev@host.local.com should pass — script over-matched (anchor regression?)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
echo "All identity-check tests passed."
