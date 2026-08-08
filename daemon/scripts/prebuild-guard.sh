#!/usr/bin/env bash
# prebuild-guard.sh: refuses to run `npm run build` when that build would
# `rm -rf dist` out from under a LIVE daemon in the MAIN checkout.
#
# WHY THIS EXISTS
#   `npm run build` starts with `rm -rf dist`. If dist/ is the code a running
#   daemon process loaded, that command deletes the live daemon's code before
#   a replacement has been compiled. This happened on this box on 2026-08-05
#   at 12:44 while a worker ran the build "just to verify it's clean" against
#   the main checkout while the daemon was up. This script is registered as
#   npm's `prebuild` hook so it runs automatically before `build`'s `rm -rf
#   dist`. No one has to remember to invoke it.
#
# WHAT IT DOES
#   1. Refuses (non-zero exit, no dist touched) only when BOTH are true:
#        - this checkout is the MAIN repo, not a git worktree
#        - a daemon is answering on the configured port
#      Escape hatch: KITHKIT_ALLOW_LIVE_BUILD=1
#   2. When the build is allowed to proceed, snapshots any existing dist/ to
#      dist.pre-<UTC timestamp>-<short sha>/ with a DEPLOYED-VERSION.txt,
#      then prunes old snapshots of ITS OWN naming pattern down to 5, never
#      touching differently-named pre-existing snapshot directories.
#
# Run as the `prebuild` step of `npm run build` (see package.json). Not meant
# to be invoked with a different cwd assumption than npm gives it.

set -euo pipefail

DAEMON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$DAEMON_ROOT/.." && pwd)"
cd "$DAEMON_ROOT"

fail() {
    echo "FATAL: prebuild-guard: $1" >&2
    exit 1
}

# ── repo identity: main checkout vs git worktree ─────────────────────────────
# Both sides MUST be normalised to absolute paths. Plain `--git-dir` returns a
# RELATIVE path in the main repo but an ABSOLUTE one in a worktree, so a naive
# comparison of raw outputs looks like it discriminates while actually
# comparing an apple to an orange. `--absolute-git-dir` and
# `--path-format=absolute --git-common-dir` normalise both sides.
GIT_DIR="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"
GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"

IS_WORKTREE=0
if [[ -n "$GIT_DIR" && -n "$GIT_COMMON_DIR" && "$GIT_DIR" != "$GIT_COMMON_DIR" ]]; then
    IS_WORKTREE=1
fi

# ── configured daemon port, read from config, never hardcoded ──────────────
# kithkit.config.yaml overrides kithkit.defaults.yaml via deep merge (see
# .claude/CLAUDE.md), so a `port:` override only present in one of the two
# files is still the correct value. Look in config.yaml first, fall back to
# defaults.yaml, exactly mirroring that merge order for this one key.
read_port() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    awk '
        /^daemon:/ { in_daemon=1; next }
        in_daemon && /^[^[:space:]]/ { in_daemon=0 }
        in_daemon && /^[[:space:]]+port:/ {
            v=$0
            sub(/^[^:]*:[[:space:]]*/, "", v)
            gsub(/["'"'"']/, "", v)
            gsub(/[[:space:]]*#.*$/, "", v)
            gsub(/[[:space:]]+$/, "", v)
            print v
            found=1
            exit
        }
        END { if (!found) exit 1 }
    ' "$file"
}

DAEMON_PORT="$(read_port "$REPO_ROOT/kithkit.config.yaml" || true)"
if [[ -z "$DAEMON_PORT" ]]; then
    DAEMON_PORT="$(read_port "$REPO_ROOT/kithkit.defaults.yaml" || true)"
fi
[[ -n "$DAEMON_PORT" ]] || fail "could not read daemon.port from kithkit.config.yaml or kithkit.defaults.yaml"

# ── is a daemon actually answering on that port? ─────────────────────────────
# This must have THREE possible outcomes, not two: the daemon IS live, the
# daemon is NOT live, or the check COULD NOT RUN at all (e.g. curl missing
# from PATH). Collapsing "could not run" into "not live" is exactly how this
# guard used to fail open: a missing curl looked identical to a quiet port.
#
# `command -v curl` establishes curl's availability separately from curl's
# own result. `command` is a POSIX shell builtin, not an external binary, so
# it cannot itself go missing from PATH the way curl can: that is what makes
# it a valid instrument for checking whether another instrument exists.
CURL_AVAILABLE=1
if ! command -v curl >/dev/null 2>&1; then
    CURL_AVAILABLE=0
fi

DAEMON_LIVE=0
CHECK_FAILED=0
if [[ "$CURL_AVAILABLE" -eq 1 ]]; then
    if curl -sf --max-time 2 "http://127.0.0.1:${DAEMON_PORT}/health" >/dev/null 2>&1; then
        DAEMON_LIVE=1
    fi
else
    CHECK_FAILED=1
fi

# ── the refusal: MAIN repo AND (live daemon OR liveness unknown) ────────────
# A destructive guard's safe default when it cannot determine liveness is to
# refuse, same as when it confirms liveness. Only a confirmed NOT-live daemon
# is allowed through silently.
if [[ "$IS_WORKTREE" -eq 0 && ( "$DAEMON_LIVE" -eq 1 || "$CHECK_FAILED" -eq 1 ) ]]; then
    if [[ "${KITHKIT_ALLOW_LIVE_BUILD:-0}" == "1" ]]; then
        if [[ "$CHECK_FAILED" -eq 1 ]]; then
            echo "prebuild-guard: WARNING: main checkout and the daemon-liveness check" \
                 "COULD NOT RUN (curl is not available on PATH), proceeding anyway because" \
                 "KITHKIT_ALLOW_LIVE_BUILD=1 is set." >&2
        else
            echo "prebuild-guard: WARNING: main checkout + live daemon on port ${DAEMON_PORT}," \
                 "proceeding anyway because KITHKIT_ALLOW_LIVE_BUILD=1 is set." >&2
        fi
    elif [[ "$CHECK_FAILED" -eq 1 ]]; then
        cat >&2 <<EOF
FATAL: prebuild-guard: refusing to build.

This is the MAIN checkout (not a git worktree), and the daemon-liveness check
COULD NOT RUN: curl is not available on PATH. This is NOT a report that no
daemon was found on port ${DAEMON_PORT}: liveness is UNKNOWN, because the
tool used to check it is missing. \`npm run build\` starts with \`rm -rf
dist\`, which would delete a live daemon's running code before a replacement
has been compiled, so the safe default when liveness cannot be determined is
to refuse. Fix PATH so curl is available, build in a git worktree instead, or
if you are certain this build should proceed anyway, set
KITHKIT_ALLOW_LIVE_BUILD=1.
EOF
        exit 1
    else
        cat >&2 <<EOF
FATAL: prebuild-guard: refusing to build.

This is the MAIN checkout (not a git worktree), and a daemon is answering on
port ${DAEMON_PORT}. \`npm run build\` starts with \`rm -rf dist\`, which would
delete that live daemon's running code before a replacement has been
compiled. Build in a git worktree instead, or if you are certain this build
should proceed anyway, set KITHKIT_ALLOW_LIVE_BUILD=1.
EOF
        exit 1
    fi
fi

# ── snapshot the existing dist before it gets rm -rf'd ──────────────────────
DIST="$DAEMON_ROOT/dist"
if [[ -d "$DIST" ]]; then
    TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    SNAPSHOT="$DAEMON_ROOT/dist.pre-${TIMESTAMP}-${SHORT_SHA}"

    cp -R "$DIST" "$SNAPSHOT"

    FULL_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

    # A bare `git status --porcelain` reports the WHOLE repo regardless of cwd.
    # The `cd "$DAEMON_ROOT"` above does NOT scope it. Measured on three
    # real machines: repo-wide dirty is always true on all three while
    # build-scope dirty differs between them, so the bare form carries zero
    # information. Scope to `src` (the actual build input) instead of `.`
    # (the daemon root); the daemon root also contains this guard's own
    # `dist.pre-*`/`dist.backup-*` snapshot directories, which `.gitignore`
    # does not match, so scoping there would make the flag self-poisoning.
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

    cat > "$SNAPSHOT/DEPLOYED-VERSION.txt" <<EOF
commit: ${FULL_SHA}
branch: ${BRANCH}
dirty_in_build_scope: ${DIRTY_IN_BUILD_SCOPE}
dirty_elsewhere: ${DIRTY_ELSEWHERE}
timestamp_utc: ${TIMESTAMP}
EOF

    echo "prebuild-guard: snapshotted dist -> $(basename "$SNAPSHOT")"

    # ── prune old snapshots of OUR OWN naming pattern only, keep newest 5 ────
    # Strict pattern match so pre-existing hand-made snapshots with different
    # naming (e.g. dist.pre-217-restart-20260802-200318.bak, dist.pre-3148-deploy)
    # are never touched, even by accident.
    PATTERN='^dist\.pre-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$'
    SNAPSHOTS=()
    while IFS= read -r line; do
        [[ -n "$line" ]] && SNAPSHOTS+=("$line")
    done < <(
        find "$DAEMON_ROOT" -maxdepth 1 -type d -name 'dist.pre-*' -exec basename {} \; \
            | grep -E "$PATTERN" \
            | sort
    )

    COUNT=${#SNAPSHOTS[@]}
    KEEP=5
    if (( COUNT > KEEP )); then
        TO_DELETE=$(( COUNT - KEEP ))
        for ((i = 0; i < TO_DELETE; i++)); do
            OLD="${SNAPSHOTS[$i]}"
            rm -rf "${DAEMON_ROOT:?}/${OLD}"
            echo "prebuild-guard: pruned old snapshot $OLD"
        done
    fi
else
    : # no existing dist: normal first build, nothing to snapshot
fi

exit 0
