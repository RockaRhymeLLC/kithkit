#!/bin/bash
# Test: read_config() path-aware awk fallback
# Verifies that the awk fallback resolves the FULL dotted key path,
# not just the leaf name, preventing false matches across YAML sections.
#
# Usage: bash scripts/lib/__tests__/test-read-config.sh
#        (or: ./scripts/lib/__tests__/test-read-config.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Fixture YAML ──────────────────────────────────────────────────────────────
FIXTURE=$(mktemp /tmp/fixture-read-config-XXXXXX.yaml)
# shellcheck disable=SC2064
trap "rm -f '$FIXTURE'" EXIT

cat > "$FIXTURE" << 'YAML'
# Test fixture for read_config path-aware awk fallback.
# voice.stt.model appears BEFORE agent.model to reproduce the regression:
# the old leaf-only grep returned "small.en" for .agent.model because
# "model: small.en" is the first "model:" line in the file.
daemon:
  port: 3847
voice:
  enabled: true
  stt:
    model: small.en
    language: en
  tts:
    enabled: false
agent:
  name: "TestAgent"
  model: claude-opus-4-8
YAML

# ── Hide yq (if installed) to force awk fallback ──────────────────────────────
_YQ_SHADOW_DIR=""
if command -v yq >/dev/null 2>&1; then
    _YQ_SHADOW_DIR=$(mktemp -d /tmp/noyq-XXXXXX)
    printf '#!/bin/sh\nexit 127\n' > "$_YQ_SHADOW_DIR/yq"
    chmod +x "$_YQ_SHADOW_DIR/yq"
    export PATH="$_YQ_SHADOW_DIR:$PATH"
    # shellcheck disable=SC2064
    trap "rm -rf '$_YQ_SHADOW_DIR' '$FIXTURE'" EXIT
fi

# ── Source the library ────────────────────────────────────────────────────────
# shellcheck source=../config.sh
source "$SCRIPT_DIR/../config.sh"

# Override to use fixture only (no real config, no defaults)
CONFIG_FILE="$FIXTURE"
DEFAULTS_FILE="/dev/null"

# ── Test harness ──────────────────────────────────────────────────────────────
PASS=0
FAIL=0

check() {
    local desc="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then
        printf 'PASS: %s\n' "$desc"
        PASS=$((PASS + 1))
    else
        printf 'FAIL: %s\n  got:  [%s]\n  want: [%s]\n' "$desc" "$got" "$want"
        FAIL=$((FAIL + 1))
    fi
}

# ── Assertions ────────────────────────────────────────────────────────────────

# (a) Regression guard: .agent.model must NOT collide with .voice.stt.model
#     Old grep-fallback would return "small.en" (first model: line in file).
#     Path-aware awk must return "claude-opus-4-8".
result=$(read_config '.agent.model' 'NOTFOUND')
check "(a) .agent.model returns claude-opus-4-8 (not small.en — regression guard)" \
    "$result" "claude-opus-4-8"

# (b) Genuine deep-nested lookup: .voice.stt.model
result=$(read_config '.voice.stt.model' 'NOTFOUND')
check "(b) .voice.stt.model returns small.en" "$result" "small.en"

# (c) Missing key: must return the provided default, not empty string
result=$(read_config '.does.not.exist' 'my-default-value')
check "(c) missing key returns provided default" "$result" "my-default-value"

# (d) One-level-deep key: .daemon.port
result=$(read_config '.daemon.port' 'NOTFOUND')
check "(d) .daemon.port resolves to 3847" "$result" "3847"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
