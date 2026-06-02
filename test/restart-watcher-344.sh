#!/usr/bin/env bash
# test/restart-watcher-344.sh — tests for kithkit#344 restart-flag path fix
#
# Covers four scenarios:
#   (1) Flag-path CWD-independence: skill snippet writes flag to the correct
#       absolute path even when CWD is a subdirectory of the project root.
#   (2) Dual-poll transition: restart-watcher detects a flag placed in the
#       legacy .claude/state/ directory (TRANSITION-ONLY block).
#   (3) Exit-code logging: restart-watcher logs "Restart FAILED" when
#       restart.sh exits nonzero (not just "Restart complete" unconditionally).
#   (4) Terminate-once: a legacy-path flag triggers restart.sh exactly once
#       and the loop terminates — i.e. the legacy flag is cleared so no
#       second poll re-fires.  Uses the REAL restart.sh so the assertion
#       fails against pre-fix restart.sh (single-path rm) and passes
#       against the fixed one (both-path rm).
#
# Usage:
#   bash test/restart-watcher-344.sh
#
# Requires: bash 4+, mktemp

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHER="$SCRIPT_DIR/../scripts/restart-watcher.sh"
REAL_RESTART="$SCRIPT_DIR/../scripts/restart.sh"
PASS=0
FAIL=0

pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }

# ── Helpers ──────────────────────────────────────────────────────────────────

# Create a minimal fake project for isolated testing.
# Copies restart-watcher.sh into the fake project so BASH_SOURCE[0] points
# to the fake scripts dir, causing config.sh to be sourced from there.
# Also stubs 'sleep' to exit instantly so the poll loop iterates without delay.
# The config.sh provides everything both restart-watcher.sh and restart.sh need
# (session_exists, kithkit_log, TMUX_BIN, TMUX_CMD, etc.) so the real restart.sh
# can be dropped in and run without touching the live system.
make_fake_project() {
    local tmpdir
    tmpdir="$(mktemp -d)"

    mkdir -p "$tmpdir/scripts/lib"
    mkdir -p "$tmpdir/.kithkit/state"
    mkdir -p "$tmpdir/.claude/state"
    mkdir -p "$tmpdir/logs"

    # Minimal config.sh: mirrors real one's BASH_SOURCE self-location logic and
    # provides stubs for everything restart.sh needs (TMUX_BIN, session_exists, etc.)
    cat > "$tmpdir/scripts/lib/config.sh" << 'CONFIGEOF'
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "$LIB_DIR")"
BASE_DIR="$(dirname "$SCRIPTS_DIR")"
STATE_DIR="$BASE_DIR/.kithkit/state"
LOG_DIR="$BASE_DIR/logs"
SESSION_NAME="test"
TMUX_BIN="true"
TMUX_CMD="true"
session_exists() { return 1; }
kithkit_log() { echo "[kithkit] $*"; }
CONFIGEOF

    # Stub start-tmux.sh so restart.sh can run to completion without touching tmux
    cat > "$tmpdir/scripts/start-tmux.sh" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$tmpdir/scripts/start-tmux.sh"

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
# Uses the updated -n guard from Fix 3 so the loop halts cleanly if root is reached.
(
    cd "$subdir"
    _d="$PWD"
    while [[ -n "$_d" && "$_d" != "/" && ! -f "$_d/scripts/lib/config.sh" ]]; do
        _d="${_d%/*}"
    done
    if [[ ! -f "$_d/scripts/lib/config.sh" ]]; then
        echo 'restart: could not locate scripts/lib/config.sh' >&2
        exit 1
    fi
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

# Stub restart.sh: mirrors PRE-fix restart.sh behavior — removes ONLY $RESTART_FLAG
# (the .kithkit path), NOT the legacy .claude flag.  This is intentionally minimal
# to prove dual-poll detection; the terminate-once correctness is covered by scenario (4).
cat > "$tmpdir/scripts/restart.sh" << EOF
#!/usr/bin/env bash
touch "$tmpdir/.ran-marker"
rm -f "$tmpdir/.kithkit/state/restart-requested"
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

# ── Scenario (4): Terminate-once — legacy flag triggers exactly one restart ───
#
# Uses the REAL restart.sh so the assertion is a true regression guard:
#   - PRE-fix restart.sh (single-path rm): legacy flag survives, watcher re-fires
#     -> invocation count > 1 -> FAIL
#   - POST-fix restart.sh (both-path rm):  legacy flag cleared, loop terminates
#     -> invocation count == 1 -> PASS

echo ""
echo "Scenario (4): Terminate-once — legacy flag triggers restart.sh exactly once"

tmpdir="$(make_fake_project)"

# Copy the real restart.sh; wrap it with a counter so we can tally invocations.
cp "$REAL_RESTART" "$tmpdir/scripts/restart.sh.real"
chmod +x "$tmpdir/scripts/restart.sh.real"

_count_file="$tmpdir/.restart-count"
_real_bin="$tmpdir/scripts/restart.sh.real"
cat > "$tmpdir/scripts/restart.sh" << WRAPEOF
#!/usr/bin/env bash
echo "invoked" >> "$_count_file"
exec "$_real_bin" "\$@"
WRAPEOF
chmod +x "$tmpdir/scripts/restart.sh"

# Place flag ONLY in the legacy .claude/state location (no .kithkit flag)
touch "$tmpdir/.claude/state/restart-requested"

# Run watcher with stubbed sleep (instant iterations) for a real-time wait of 3 s
run_watcher_briefly "$tmpdir" 3

invoke_count=0
if [ -f "$_count_file" ]; then
    invoke_count=$(wc -l < "$_count_file" | tr -d '[:space:]')
fi

if [ "$invoke_count" -eq 1 ]; then
    pass "terminate-once: restart.sh invoked exactly once (legacy flag cleared by Fix 1)"
else
    fail "terminate-once: restart.sh invoked ${invoke_count} times (expected 1 — loop re-fired; Fix 1 missing?)"
fi

# Verify the legacy flag was actually removed (belt-and-suspenders)
if [ ! -f "$tmpdir/.claude/state/restart-requested" ]; then
    pass "terminate-once: legacy flag removed after restart cycle"
else
    fail "terminate-once: legacy flag still present after restart cycle (Fix 1 not applied?)"
fi

cleanup "$tmpdir"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
