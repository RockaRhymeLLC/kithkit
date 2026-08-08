#!/usr/bin/env bash
# postbuild-info.sh: writes dist/BUILD-INFO.json after a successful build so
# "what is actually deployed?" is a `cat`, not a hunt for a symbol in compiled
# output.
#
# Run as the `postbuild` step of `npm run build` (see package.json).

set -euo pipefail

DAEMON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DAEMON_ROOT"

DIST="$DAEMON_ROOT/dist"
[[ -d "$DIST" ]] || { echo "FATAL: postbuild-info: $DIST does not exist" >&2; exit 1; }

FULL_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# A bare `git status --porcelain` reports the WHOLE repo regardless of cwd.
# The `cd "$DAEMON_ROOT"` above does NOT scope it. Measured on three real
# machines: repo-wide dirty is always true on all three while build-scope
# dirty differs between them, so the bare form carries zero information.
# Scope to `src` (the actual build input) instead of `.` (the daemon root);
# the daemon root also contains this guard's own `dist.pre-*`/`dist.backup-*`
# snapshot directories, which `.gitignore` does not match, so scoping there
# would make the flag self-poisoning.
FULL_STATUS="$(git status --porcelain 2>/dev/null || true)"
SRC_STATUS="$(git status --porcelain -- src 2>/dev/null || true)"

if [[ -n "$SRC_STATUS" ]]; then
    DIRTY_IN_BUILD_SCOPE=true
else
    DIRTY_IN_BUILD_SCOPE=false
fi

if [[ -z "$FULL_STATUS" ]]; then
    DIRTY_ELSEWHERE=false
else
    ELSEWHERE="$(comm -23 <(sort <<<"$FULL_STATUS") <(sort <<<"$SRC_STATUS") 2>/dev/null || true)"
    if [[ -n "$ELSEWHERE" ]]; then
        DIRTY_ELSEWHERE=true
    else
        DIRTY_ELSEWHERE=false
    fi
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$DIST/BUILD-INFO.json" <<EOF
{
  "commit": "${FULL_SHA}",
  "branch": "${BRANCH}",
  "dirty_in_build_scope": ${DIRTY_IN_BUILD_SCOPE},
  "dirty_elsewhere": ${DIRTY_ELSEWHERE},
  "build_timestamp_utc": "${TIMESTAMP}"
}
EOF

echo "postbuild-info: wrote dist/BUILD-INFO.json"
