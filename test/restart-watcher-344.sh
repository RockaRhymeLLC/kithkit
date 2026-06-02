#!/usr/bin/env bash
# test/restart-watcher-344.sh — tests for kithkit#344 restart-flag path fix
#
# Covers three scenarios:
#   (1) Flag-path CWD-independence: skill snippet writes flag to the correct
#       absolute path even when CWD is a subdirectory of the project root.
#   (2) Dual-poll transition: restart-watcher detects a flag placed in the
#       legacy .claude/state/ directory (TRANSITION-ONLY block).
#   (3) Exit-code logging: restart-watcher logs "Restart FAILED" when
#       restart.sh exits nonzero (not just "Restart complete" unconditionally).
#
# Usage:
#   bash test/restart-watcher-344.sh
#
# Requires: bash 4+, mktemp

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHER="$SCRIPT_DIR/../scripts/restart-watcher.sh"
PASS=0
FAIL=0

pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }

# ── Helpers ──────────────────────────────────────────────────────────────────

# Create a minimal fake project for isolated testing.
# Copies restart-watcher.sh into the fake project so BASH_SOURCE[0] points
# to the fake scripts dir, causing config.sh to be sourced from there.
# Also stubs 'sleep' to exit instantly so the poll loop iterates without delay.
make_fake_project() {
    local tmpdir
    tmpdir="$(mktemp -d)"

    mkdir -p "$tmpdir/scripts/lib"
    mkdir -p "$tmpdir/.kithkit/state"
    mkdir -p "$tmpdir/.claude/state"
    mkdir -p "$tmpdir/logs"

    # Minimal config.sh that mirrors the real one's BASH_SOURCE self-location logic
    cat > "$tmpdir/scripts/lib/config.sh" << 'CONFIGEOF'
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "$LIB_DIR")"
BASE_DIR="$(dirname "$SCRIPTS_DIR")"
STATE_DIR="$BASE_DIR/.kithkit/state"
LOG_DIR="$BASE_DIR/logs"
SESSION_NAME="test"
CONFIGEOF

    # Copy the watcher so its BASH_SOURCE resolves inside this fake project
    cp "$WATCHER" "$tmpdir/scripts/restart-watcher.sh"
    chmod +x "$tmpdir/scripts/restart-watcher.sh"

    # Stub sleep to exit immediately so the poll loop iterates without delay
    mkdir -p "$tmpdir/bin"
    printf '#!/bin/bash\nexit 0\n' > "$tmpdir/bin/sleep"
    chmod +x "$tmpdir/bin/sleep"

    echo "$tmpdir"
}

# Run watcher in background with a stubbed PATH, wait briefly, then kill it.
# Usage: run_watcher_briefly <tmpdir> <wait_seconds>
run_watcher_briefly() {
    local tmpdir="$1"
    local wait="${2:-2}"
    local wpid

    env PATH="$tmpdir/bin:$PATH" bash "$tmpdir/scripts/restart-watcher.sh" &
    wpid=$!
    sleep "$wait"
    kill "$wpid" 2>/dev/null || true
    wait "$wpid" 2>/dev/null || true
}

cleanup() { rm -rf "$1"; }

# ── Scenario (1): CWD-independent flag write via skill snippet ────────────────

echo ""
echo "Scenario (1): CWD-independent flag write"

tmpdir="$(make_fake_project)"
subdir="$tmpdir/some/nested/subdir"
mkdir -p "$subdir"

# Run the skill's flag-write snippet from a non-root CWD.
# The snippet walks upward from CWD to find scripts/lib/config.sh, sources it
# for an absolute STATE_DIR, then touches $STATE_DIR/restart-requested.
(
    cd "$subdir"
    _d="$PWD"
    while [[ "$_d" != "/" && ! -f "$_d/scripts/lib/config.sh" ]]; do
        _d="${_d%/*}"
    done
    # shellcheck disable=SC1090
    source "$_d/scripts/lib/config.sh"
    touch "$STATE_DIR/restart-requested"
)

expected_flag="$tmpdir/.kithkit/state/restart-requested"
if [ -f "$expected_flag" ]; then
    pass "flag written to correct absolute path from non-root CWD ($subdir)"
else
    fail "flag NOT found at $expected_flag (CWD was $subdir)"
    echo "    Contents of $tmpdir/.kithkit/state/: $(ls "$tmpdir/.kithkit/state/" 2>/dev/null || echo 'empty')"
fi

cleanup "$tmpdir"

# ── Scenario (2): Dual-poll detects .claude/state flag ───────────────────────

echo ""
echo "Scenario (2): Dual-poll — flag in legacy .claude/state/"

tmpdir="$(make_fake_project)"

# Stub restart.sh: record invocation, remove flags so the loop settles
cat > "$tmpdir/scripts/restart.sh" << EOF
#!/usr/bin/env bash
touch "$tmpdir/.ran-marker"
rm -f "$tmpdir/.kithkit/state/restart-requested"
rm -f "$tmpdir/.claude/state/restart-requested"
exit 0
EOF
chmod +x "$tmpdir/scripts/restart.sh"

# Place flag ONLY in the legacy .claude/state location
touch "$tmpdir/.claude/state/restart-requested"

run_watcher_briefly "$tmpdir" 2

if [ -f "$tmpdir/.ran-marker" ]; then
    pass "dual-poll: restart.sh invoked when flag placed in .claude/state/"
else
    fail "dual-poll: restart.sh NOT invoked despite flag in .claude/state/"
    echo "    Log: $(cat "$tmpdir/logs/restart-watcher.log" 2>/dev/null || echo 'no log')"
fi

cleanup "$tmpdir"

# ── Scenario (3): Exit-code logging emits FAILED on nonzero exit ─────────────

echo ""
echo "Scenario (3): Exit-code logging — restart.sh exits nonzero"

tmpdir="$(make_fake_project)"

# Stub restart.sh: exit nonzero; leave flag so watcher keeps detecting it
# (we rely on kill to terminate the loop)
cat > "$tmpdir/scripts/restart.sh" << 'EOF'
#!/usr/bin/env bash
exit 42
EOF
chmod +x "$tmpdir/scripts/restart.sh"

# Pre-place the restart flag
touch "$tmpdir/.kithkit/state/restart-requested"

run_watcher_briefly "$tmpdir" 2

logfile="$tmpdir/logs/restart-watcher.log"
if [ -f "$logfile" ] && grep -q "Restart FAILED (exit 42)" "$logfile"; then
    pass "exit-code logging: 'Restart FAILED (exit 42)' found in log"
else
    fail "exit-code logging: 'Restart FAILED (exit 42)' NOT found in log"
    echo "    Log: $(cat "$logfile" 2>/dev/null || echo 'no log')"
fi

# Confirm "Restart complete" is NOT present (no false success)
if grep -q "Restart complete" "$logfile" 2>/dev/null; then
    fail "exit-code logging: spurious 'Restart complete' found despite nonzero exit"
else
    pass "exit-code logging: no spurious 'Restart complete' on failure"
fi

cleanup "$tmpdir"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
