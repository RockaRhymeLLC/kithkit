#!/usr/bin/env bash
# test/watchdog-label-374.sh — mutation-kill tests for PR #374 LAUNCHD_LABEL parameterization
#
# Covers six scenarios:
#   (1) Substituted placeholder: sed-replaced at install time -> resolves to substituted value
#   (2) KITHKIT_LAUNCHD_LABEL env var: resolves to env value
#   (3) --label flag: resolves to flag value
#   (4) Flag wins over env: both --label and KITHKIT_LAUNCHD_LABEL set -> flag wins
#   (5) --label with no value: exits non-zero (usage error)
#   (6) Unsubstituted placeholder, no override -> fail-loud: exits non-zero, no kickstart,
#       actionable error logged/emitted
#
# Mutation-kill strategy:
#   Scenarios 1-4 use --dry-run. When the health check fails (stub curl exits 7),
#   the watchdog proceeds to do_kickstart(), which in dry-run mode logs:
#     "DRY-RUN would-kickstart: launchctl kickstart -k gui/<uid>/<label>"
#   If the label were hardcoded to com.assistant.daemon, the log line would not
#   match the expected label and the scenario would fail.
#
#   Scenario 6 is the mutation guard for the fail-loud check: reverting the check
#   would cause the script to reach dry-run and log "DRY-RUN would-kickstart" (exit 0),
#   but the test expects exit non-zero and the FATAL message — so it would fail.
#
# Usage:
#   bash test/watchdog-label-374.sh
#
# Requires: bash, mktemp, sed, id

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG="$SCRIPT_DIR/../scripts/daemon-watchdog.sh"
PASS=0
FAIL=0

pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }

# ── Helpers ───────────────────────────────────────────────────────────────────

# Create a minimal fake project with:
#   - a copy of daemon-watchdog.sh in scripts/ (BASH_SOURCE -> fake scripts dir,
#     REPO_ROOT = dirname of scripts/ = tmpdir)
#   - a stub curl (exit 7 = CURLE_COULDNT_CONNECT) so the health check always
#     fails and the watchdog enters the kickstart path
make_fake_project() {
    local tmpdir
    tmpdir="$(mktemp -d)"
    mkdir -p "$tmpdir/scripts" "$tmpdir/logs" "$tmpdir/bin"

    # Stub curl: exit 7 (connection refused) -> do_health_check returns "000:7"
    # -> classify_failure returns "connect-refused" -> failure path -> do_kickstart()
    printf '#!/usr/bin/env bash\nexit 7\n' > "$tmpdir/bin/curl"
    chmod +x "$tmpdir/bin/curl"

    # Copy the watchdog into the fake project so BASH_SOURCE[0] resolves to
    # $tmpdir/scripts/daemon-watchdog.sh and REPO_ROOT = $tmpdir
    cp "$WATCHDOG" "$tmpdir/scripts/daemon-watchdog.sh"
    chmod +x "$tmpdir/scripts/daemon-watchdog.sh"

    echo "$tmpdir"
}

cleanup() { rm -rf "$1"; }

# Build the expected dry-run log line for a given resolved label.
expected_dry_run_log() {
    local label="$1"
    echo "DRY-RUN would-kickstart: launchctl kickstart -k gui/$(id -u)/${label}"
}

# ── Scenario (1): Substituted placeholder (sed-installed at install time) ─────

echo ""
echo "Scenario (1): Substituted placeholder (sed-installed default)"

tmpdir="$(make_fake_project)"

# Simulate a proper install: sed-replace __LAUNCHD_LABEL__ -> com.kithkit.daemon
# Use -i.bak for BSD sed (macOS) compatibility; clean up the backup file.
sed -i.bak 's/__LAUNCHD_LABEL__/com.kithkit.daemon/g' "$tmpdir/scripts/daemon-watchdog.sh"
rm -f "$tmpdir/scripts/daemon-watchdog.sh.bak"

# No env var, no --label flag; label comes entirely from the substituted placeholder.
env PATH="$tmpdir/bin:$PATH" \
    bash "$tmpdir/scripts/daemon-watchdog.sh" --dry-run 2>/dev/null || true

expected="$(expected_dry_run_log "com.kithkit.daemon")"
if grep -qF "$expected" "$tmpdir/logs/watchdog.log" 2>/dev/null; then
    pass "substituted placeholder: resolved to com.kithkit.daemon"
else
    fail "substituted placeholder: expected '$expected' in log"
    echo "    Log: $(cat "$tmpdir/logs/watchdog.log" 2>/dev/null || echo 'no log')"
fi

cleanup "$tmpdir"

# ── Scenario (2): KITHKIT_LAUNCHD_LABEL env var ──────────────────────────────

echo ""
echo "Scenario (2): KITHKIT_LAUNCHD_LABEL env var override"

tmpdir="$(make_fake_project)"

# No sed substitution; unresolved placeholder in script.
# Env var provides the label override.
env PATH="$tmpdir/bin:$PATH" \
    KITHKIT_LAUNCHD_LABEL=com.example.env \
    bash "$tmpdir/scripts/daemon-watchdog.sh" --dry-run 2>/dev/null || true

expected="$(expected_dry_run_log "com.example.env")"
if grep -qF "$expected" "$tmpdir/logs/watchdog.log" 2>/dev/null; then
    pass "env var override: resolved to com.example.env"
else
    fail "env var override: expected '$expected' in log"
    echo "    Log: $(cat "$tmpdir/logs/watchdog.log" 2>/dev/null || echo 'no log')"
fi

cleanup "$tmpdir"

# ── Scenario (3): --label flag ────────────────────────────────────────────────

echo ""
echo "Scenario (3): --label flag override"

tmpdir="$(make_fake_project)"

env PATH="$tmpdir/bin:$PATH" \
    bash "$tmpdir/scripts/daemon-watchdog.sh" --dry-run --label com.example.flag 2>/dev/null || true

expected="$(expected_dry_run_log "com.example.flag")"
if grep -qF "$expected" "$tmpdir/logs/watchdog.log" 2>/dev/null; then
    pass "--label flag: resolved to com.example.flag"
else
    fail "--label flag: expected '$expected' in log"
    echo "    Log: $(cat "$tmpdir/logs/watchdog.log" 2>/dev/null || echo 'no log')"
fi

cleanup "$tmpdir"

# ── Scenario (4): --label flag wins over KITHKIT_LAUNCHD_LABEL env var ───────

echo ""
echo "Scenario (4): --label flag wins over KITHKIT_LAUNCHD_LABEL (precedence)"

tmpdir="$(make_fake_project)"

env PATH="$tmpdir/bin:$PATH" \
    KITHKIT_LAUNCHD_LABEL=com.example.env \
    bash "$tmpdir/scripts/daemon-watchdog.sh" --dry-run --label com.example.flag 2>/dev/null || true

expected_flag="$(expected_dry_run_log "com.example.flag")"
expected_env="$(expected_dry_run_log "com.example.env")"

if grep -qF "$expected_flag" "$tmpdir/logs/watchdog.log" 2>/dev/null; then
    pass "--label wins over env: flag value com.example.flag in log"
else
    fail "--label wins over env: expected flag value '$expected_flag' in log"
    echo "    Log: $(cat "$tmpdir/logs/watchdog.log" 2>/dev/null || echo 'no log')"
fi

# Extra guard: env label must NOT appear (confirms flag took precedence)
if grep -qF "$expected_env" "$tmpdir/logs/watchdog.log" 2>/dev/null; then
    fail "--label wins over env: env value com.example.env found in log (flag should have won)"
else
    pass "--label wins over env: env value com.example.env not chosen"
fi

cleanup "$tmpdir"

# ── Scenario (5): --label with no value -> usage error ───────────────────────

echo ""
echo "Scenario (5): --label with no value (missing argument -> exit non-zero)"

tmpdir="$(make_fake_project)"

exit_code=0
env PATH="$tmpdir/bin:$PATH" \
    bash "$tmpdir/scripts/daemon-watchdog.sh" --label 2>/dev/null || exit_code=$?

if [[ "$exit_code" -ne 0 ]]; then
    pass "--label with no value: exited non-zero (exit $exit_code)"
else
    fail "--label with no value: exited 0 (expected non-zero usage error)"
fi

cleanup "$tmpdir"

# ── Scenario (6): Unsubstituted placeholder -> fail-loud ─────────────────────

echo ""
echo "Scenario (6): Unsubstituted placeholder, no override -> fail-loud exit"

tmpdir="$(make_fake_project)"

# NO sed substitution; NO env var; NO --label flag.
# The placeholder __LAUNCHD_LABEL__ is still literal in the copied script.
exit_code=0
err_output=""
err_output="$(env PATH="$tmpdir/bin:$PATH" \
    bash "$tmpdir/scripts/daemon-watchdog.sh" --dry-run 2>&1 >/dev/null)" || exit_code=$?

# Must exit non-zero
if [[ "$exit_code" -ne 0 ]]; then
    pass "fail-loud: exited non-zero (exit $exit_code)"
else
    fail "fail-loud: exited 0 (expected non-zero; fail-loud check missing?)"
fi

# watchdog.log must contain the FATAL message
if grep -q "FATAL:" "$tmpdir/logs/watchdog.log" 2>/dev/null; then
    pass "fail-loud: FATAL message written to watchdog.log"
else
    fail "fail-loud: FATAL message NOT found in watchdog.log"
    echo "    Log: $(cat "$tmpdir/logs/watchdog.log" 2>/dev/null || echo 'no log')"
fi

# stderr must contain the FATAL message (actionable error emitted to operator)
if echo "$err_output" | grep -q "FATAL:"; then
    pass "fail-loud: FATAL message emitted to stderr"
else
    fail "fail-loud: FATAL message NOT emitted to stderr"
    echo "    stderr: $err_output"
fi

# Must NOT have reached the dry-run kickstart path (fail-loud triggers before that log line)
if grep -q "DRY-RUN would-kickstart" "$tmpdir/logs/watchdog.log" 2>/dev/null; then
    fail "fail-loud: 'DRY-RUN would-kickstart' found in log (kickstart should not have been attempted)"
else
    pass "fail-loud: no kickstart attempted (DRY-RUN line absent from log)"
fi

cleanup "$tmpdir"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
