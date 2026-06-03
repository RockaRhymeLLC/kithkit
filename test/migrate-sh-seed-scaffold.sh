#!/usr/bin/env bash
# test/migrate-sh-seed-scaffold.sh — smoke tests for migrate.sh seed-scaffold fix (#309)
#
# Tests three scenarios:
#   (i)   Clean install: no .kithkit/ at all → migration runs cleanly
#   (ii)  Manifest exists → exits 1 with already-migrated error
#   (iii) Upstream-seed only: .kithkit/hooks/ has files but no manifest → migration
#         runs without clobbering existing files
#
# Usage:
#   bash test/migrate-sh-seed-scaffold.sh
#
# Requires: bash 4+, rsync, mktemp

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATE_SH="$SCRIPT_DIR/../migrate.sh"
PASS=0
FAIL=0

# ── Helpers ──────────────────────────────────────────────────

pass() {
  echo "  PASS: $*"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $*"
  FAIL=$((FAIL + 1))
}

# Set up a minimal fake project directory for migrate.sh to operate in.
# migrate.sh uses SCRIPT_DIR as PROJECT_DIR, so we symlink migrate.sh into
# the temp dir and call it from there.
make_fake_project() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  # Symlink migrate.sh into the temp project so SCRIPT_DIR == tmpdir
  ln -s "$MIGRATE_SH" "$tmpdir/migrate.sh"
  # Minimal .claude/ structure
  mkdir -p "$tmpdir/.claude/hooks"
  mkdir -p "$tmpdir/.claude/state"
  mkdir -p "$tmpdir/.claude/agents"
  mkdir -p "$tmpdir/.claude/skills"
  echo '{}' > "$tmpdir/.claude/settings.json"
  echo '# CLAUDE' > "$tmpdir/.claude/CLAUDE.md"
  # Stub curl so the daemon-running check in migrate.sh reports daemon as absent.
  # migrate.sh checks: if curl -s ... http://localhost:3847/health → exit 1
  # Our stub always exits 1 (connection refused) so the guard proceeds.
  mkdir -p "$tmpdir/bin"
  cat > "$tmpdir/bin/curl" << 'CURL_STUB'
#!/usr/bin/env bash
exit 1
CURL_STUB
  chmod +x "$tmpdir/bin/curl"
  echo "$tmpdir"
}

cleanup() {
  local dir="$1"
  rm -rf "$dir"
}

# ── Scenario (i): Clean install — no .kithkit/ at all ───────

echo ""
echo "Scenario (i): Clean install — no .kithkit/"

tmpdir="$(make_fake_project)"

# Add a hook file to .claude/hooks/ to give move_file() something to move
echo "#!/bin/bash" > "$tmpdir/.claude/hooks/pre-session.sh"

rc=0
output="$(PATH="$tmpdir/bin:$PATH" bash "$tmpdir/migrate.sh" --yes 2>&1)" || rc=$?

if [ "$rc" -eq 0 ]; then
  pass "migrate.sh exited 0"
else
  fail "migrate.sh exited $rc (expected 0)"
  echo "    Output: $output"
fi

if [ -f "$tmpdir/migrate-rollback.manifest" ]; then
  pass "manifest created"
else
  fail "manifest not created"
fi

if [ -f "$tmpdir/.kithkit/hooks/pre-session.sh" ]; then
  pass "hook file moved to .kithkit/hooks/"
else
  fail "hook file not moved to .kithkit/hooks/"
fi

if [ ! -f "$tmpdir/.claude/hooks/pre-session.sh" ]; then
  pass "hook file removed from .claude/hooks/"
else
  fail "hook file still present in .claude/hooks/"
fi

cleanup "$tmpdir"

# ── Scenario (ii): Manifest exists → exit 1 ──────────────────

echo ""
echo "Scenario (ii): Manifest exists → exit 1"

tmpdir="$(make_fake_project)"
touch "$tmpdir/migrate-rollback.manifest"

rc=0
output="$(PATH="$tmpdir/bin:$PATH" bash "$tmpdir/migrate.sh" --yes 2>&1)" || rc=$?

if [ "$rc" -ne 0 ]; then
  pass "migrate.sh exited non-zero (as expected)"
else
  fail "migrate.sh exited 0 but should have exited 1"
fi

if echo "$output" | grep -q "Manifest already exists\|already run"; then
  pass "output contains already-migrated error message"
else
  fail "output missing already-migrated error message"
  echo "    Output: $output"
fi

cleanup "$tmpdir"

# ── Scenario (iii): Upstream-seed only — hooks in dst, no manifest ──

echo ""
echo "Scenario (iii): Upstream-shipped seed — .kithkit/hooks/ has files, no manifest"

tmpdir="$(make_fake_project)"

# Simulate upstream-shipped seed: .kithkit/hooks/ exists with a file
mkdir -p "$tmpdir/.kithkit/hooks"
echo "#!/bin/bash" > "$tmpdir/.kithkit/hooks/upstream-seed.sh"

# Also put a hook in .claude/hooks/ — should NOT overwrite the seed file if same name
echo "#!/bin/bash # operator custom" > "$tmpdir/.claude/hooks/upstream-seed.sh"
echo "#!/bin/bash" > "$tmpdir/.claude/hooks/another-hook.sh"

rc=0
output="$(PATH="$tmpdir/bin:$PATH" bash "$tmpdir/migrate.sh" --yes 2>&1)" || rc=$?

if [ "$rc" -eq 0 ]; then
  pass "migrate.sh exited 0 (proceeded despite seed files in dst)"
else
  fail "migrate.sh exited $rc (expected 0 for seed scenario)"
  echo "    Output: $output"
fi

if echo "$output" | grep -qi "seed scaffold\|upstream-shipped"; then
  pass "output contains informational seed-scaffold message"
else
  fail "output missing informational seed-scaffold message"
  echo "    Output: $output"
fi

# Seed file content must be preserved (not overwritten by .claude version)
seed_content="$(cat "$tmpdir/.kithkit/hooks/upstream-seed.sh" 2>/dev/null || echo "")"
if echo "$seed_content" | grep -q "operator custom"; then
  fail "seed file was overwritten by .claude version (should have been preserved)"
elif [ -f "$tmpdir/.kithkit/hooks/upstream-seed.sh" ]; then
  pass "seed file preserved (not overwritten)"
else
  fail "seed file missing"
fi

# The other hook (not a collision) should be moved over
if [ -f "$tmpdir/.kithkit/hooks/another-hook.sh" ]; then
  pass "non-colliding hook moved to .kithkit/hooks/"
else
  fail "non-colliding hook not moved to .kithkit/hooks/"
fi

# Manifest must exist after successful migration
if [ -f "$tmpdir/migrate-rollback.manifest" ]; then
  pass "manifest created"
else
  fail "manifest not created"
fi

cleanup "$tmpdir"

# ── Summary ──────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
