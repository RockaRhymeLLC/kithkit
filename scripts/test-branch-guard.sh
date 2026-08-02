#!/usr/bin/env bash
# test-branch-guard.sh — matrix test for the branch-guard hook worktree predicate.
#
# Verifies that linked worktrees are EXEMPT and all other contexts are BLOCKED,
# using real git filesystem state — no stubs, no monkeypatching.
#
# DISCRIMINATION RULE: assert on OUTPUT CONTENT, never on exit status.
#   BLOCKED == stdout contains '"decision"' AND '"block"'
#   EXEMPT  == that block JSON is ABSENT from stdout
#
# PIPE RULE: stdin must be a pipe (printf … | bash hook) so [[ -p /dev/stdin ]]
# is true inside the hook. herestrings/redirects skip the pipe check → INPUT=""
# → hook no-ops → every row would silently "pass" while testing nothing.
#
# CWD RULE: each row uses a subshell (cd "$dir" && bash "$HOOK") so one row's
# CWD cannot leak into the next.
#
# Usage: bash scripts/test-branch-guard.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../.claude/hooks/branch-guard.sh"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# Capture real git once, before any PATH change, so shims cannot recurse into themselves.
REAL_GIT=$(command -v git)

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

pass()  { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail()  { echo "FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
skip()  { echo "SKIP: $1 — $2"; SKIP_COUNT=$((SKIP_COUNT + 1)); }

# A PreToolUse payload whose command would leave main.
PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git checkout somefeature"}}'

is_blocked() {
  echo "$1" | grep -q '"decision"' && echo "$1" | grep -q '"block"'
}

# Run hook from dir $1 with explicit stdin $2.
# Populates globals _out (stdout), _err (stderr), _st (exit status).
# Uses if/then/else so a non-zero hook exit does not abort the script
# under set -euo pipefail, and is safe on both bash 3.2 and 5.x.
run_hook_full() {
  local dir="$1" input="$2"
  local err_file="$WORK_DIR/_hook_stderr"
  if _out=$(printf '%s' "$input" | (cd "$dir" && bash "$HOOK" 2>"$err_file")); then
    _st=0
  else
    _st=$?
  fi
  _err=$(cat "$err_file" 2>/dev/null || true)
}

# Returns 0 if the hook ran cleanly: exit status 0 AND no crash signature on stderr.
# DO NOT remove this in favour of content-only assertions.  A dead hook (exit N,
# syntax error, command not found, etc.) also produces empty stdout, and empty
# stdout passes every EXEMPT / no-op content check.  The exit-status check answers
# "did the hook run at all"; the content check answers "was the result correct".
# Both must hold; the row passes only when both hold.
is_live() {
  local st="$1" stderr="$2"
  [ "$st" -eq 0 ] || return 1
  ! printf '%s\n' "$stderr" | grep -Eqi "syntax error|command not found|No such file or directory"
}

# Run hook from $1, capture stdout only.
run_hook() {
  printf '%s' "$PAYLOAD" | (cd "$1" && bash "$HOOK" 2>/dev/null)
}

# Run hook from $1, capture stderr only.
run_hook_err() {
  printf '%s' "$PAYLOAD" | (cd "$1" && bash "$HOOK" 2>&1 >/dev/null)
}

# Create a minimal main repo at $1 with one commit.
make_main_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -b main -q
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test Runner"
  git -C "$dir" commit -q --allow-empty -m "init"
}

# Add a linked worktree at $2 off main repo at $1.
make_worktree() {
  local main_dir="$1" wt_dir="$2" branch_name="$3"
  git -C "$main_dir" worktree add -q -b "$branch_name" "$wt_dir"
}

# ── Fixture setup ─────────────────────────────────────────────────────────────

# Shared base repo for rows 1-3
MAIN_SHARED="$WORK_DIR/shared-main"
make_main_repo "$MAIN_SHARED"

# Row 1: linked worktree at its root
WT_R1="$WORK_DIR/wt-r1"
make_worktree "$MAIN_SHARED" "$WT_R1" "feat-r1"

# Row 2: subdirectory inside row-1 worktree
mkdir -p "$WT_R1/sub/deep"

# Row 3: linked worktree at path with no 'worktrees' or '.kithkit' in it
WT_R3="$WORK_DIR/feature-dev"
make_worktree "$MAIN_SHARED" "$WT_R3" "feat-r3"

# Rows 4-5: plain main repo
MAIN_R4="$WORK_DIR/row4-main"
make_main_repo "$MAIN_R4"
mkdir -p "$MAIN_R4/a/b/c"

# Row 6: main repo under a directory literally named 'worktrees'
MAIN_R6="$WORK_DIR/worktrees/myrepo"
make_main_repo "$MAIN_R6"

# Row 6b: plainly-named main repo (control for row 6)
MAIN_R6B="$WORK_DIR/plainrepo"
make_main_repo "$MAIN_R6B"

# Row 7: main repo at <tmp>/.kithkit/worktrees/myrepo (old $PWD glob path)
MAIN_R7="$WORK_DIR/.kithkit/worktrees/myrepo"
make_main_repo "$MAIN_R7"

# Row 8: non-git directory
NONGIT_R8="$WORK_DIR/nongit"
mkdir -p "$NONGIT_R8"

# Row 9: directory containing a bare .git directory (malformed git state)
DIR_R9="$WORK_DIR/row9"
mkdir -p "$DIR_R9/.git"
echo "ref: refs/heads/main" > "$DIR_R9/.git/HEAD"
# No objects/, no refs/ → not a usable git repo; git may or may not accept it

# Row 10: repo with HEAD on a non-main branch (for SessionStart test)
REPO_R10="$WORK_DIR/row10"
make_main_repo "$REPO_R10"
git -C "$REPO_R10" checkout -b otherfeature -q

# Rows 14: stale worktree variant A — .git pointer file deleted
MAIN_R14="$WORK_DIR/row14-main"
make_main_repo "$MAIN_R14"
WT_R14="$WORK_DIR/row14-wt"
make_worktree "$MAIN_R14" "$WT_R14" "feat-r14"
# Variant A: delete the .git pointer file from the worktree directory.
# (Row 14's variant-A fixture: a worktree whose .git file has been deleted.
#  This doubles as the variant-A stale-worktree case; row 16 tests variant B.)
rm "$WT_R14/.git"

# Row 16: stale worktree variant B — .git pointer file intact, backing metadata deleted
MAIN_R16="$WORK_DIR/row16-main"
make_main_repo "$MAIN_R16"
WT_R16="$WORK_DIR/row16-wt"
make_worktree "$MAIN_R16" "$WT_R16" "feat-r16"
# Variant B: delete the main repo's .git/worktrees/<name> backing metadata
# while leaving the worktree's .git pointer file in place.
wt_backing=$(ls "$MAIN_R16/.git/worktrees/" 2>/dev/null | head -1)
if [ -n "$wt_backing" ]; then
  rm -rf "$MAIN_R16/.git/worktrees/$wt_backing"
fi

# ── Tests ─────────────────────────────────────────────────────────────────────

echo ""
echo "=== branch-guard worktree-predicate matrix ==="
echo ""

# ── EXEMPT rows ───────────────────────────────────────────────────────────────

run_hook_full "$WT_R1" "$PAYLOAD"
# Exit status guards liveness; content guards exemption.  Both must hold:
# a dead hook also produces empty stdout and would pass the content check alone.
if ! is_live "$_st" "$_err"; then
  fail "Row 1:  linked worktree at root → LIVENESS FAIL (exit=$_st stderr='$_err')"
elif ! is_blocked "$_out"; then
  pass "Row 1:  linked worktree at root → EXEMPT"
else
  fail "Row 1:  linked worktree at root should be EXEMPT (content check: got '$_out')"
fi

run_hook_full "$WT_R1/sub/deep" "$PAYLOAD"
# Exit status guards liveness; content guards exemption.  Both must hold:
# a dead hook also produces empty stdout and would pass the content check alone.
if ! is_live "$_st" "$_err"; then
  fail "Row 2:  linked worktree in subdir → LIVENESS FAIL (exit=$_st stderr='$_err')"
elif ! is_blocked "$_out"; then
  pass "Row 2:  linked worktree in subdir → EXEMPT"
else
  fail "Row 2:  linked worktree in subdir should be EXEMPT (content check: got '$_out')"
fi

run_hook_full "$WT_R3" "$PAYLOAD"
# Exit status guards liveness; content guards exemption.  Both must hold:
# a dead hook also produces empty stdout and would pass the content check alone.
if ! is_live "$_st" "$_err"; then
  fail "Row 3:  linked worktree at neutral path (no 'worktrees'/.kithkit) → LIVENESS FAIL (exit=$_st stderr='$_err')"
elif ! is_blocked "$_out"; then
  pass "Row 3:  linked worktree at neutral path (no 'worktrees'/.kithkit) → EXEMPT"
else
  fail "Row 3:  linked worktree at neutral path should be EXEMPT (content check: got '$_out')"
fi

# ── BLOCKED rows ──────────────────────────────────────────────────────────────

out=$(run_hook "$MAIN_R4")
if is_blocked "$out"; then
  pass "Row 4:  main repo root → BLOCKED"
else
  fail "Row 4:  main repo root should be BLOCKED"
fi

out=$(run_hook "$MAIN_R4/a/b/c")
if is_blocked "$out"; then
  pass "Row 5:  main repo deep subdir → BLOCKED"
else
  fail "Row 5:  main repo deep subdir should be BLOCKED"
fi

out=$(run_hook "$MAIN_R6")
if is_blocked "$out"; then
  pass "Row 6:  main repo under dir named 'worktrees' → BLOCKED"
else
  fail "Row 6:  main repo under 'worktrees' dir should be BLOCKED"
fi

out=$(run_hook "$MAIN_R6B")
if is_blocked "$out"; then
  pass "Row 6b: plainly-named main repo → BLOCKED (control for row 6)"
else
  fail "Row 6b: plainly-named main repo should be BLOCKED"
fi

out=$(run_hook "$MAIN_R7")
if is_blocked "$out"; then
  pass "Row 7:  main repo at .kithkit/worktrees/ path → BLOCKED"
else
  fail "Row 7:  main repo at .kithkit/worktrees/ should be BLOCKED"
fi

out=$(run_hook "$NONGIT_R8" 2>/dev/null || true)
if is_blocked "$out"; then
  pass "Row 8:  non-git directory → BLOCKED, no crash"
else
  fail "Row 8:  non-git directory should be BLOCKED"
fi

out=$(run_hook "$DIR_R9" 2>/dev/null || true)
if is_blocked "$out"; then
  pass "Row 9:  malformed .git directory → BLOCKED, no crash"
else
  fail "Row 9:  malformed .git directory should be BLOCKED"
fi

# ── Functional rows ───────────────────────────────────────────────────────────

SESSION_PAYLOAD='{"hook_event_name":"SessionStart"}'
hook_err=$(printf '%s' "$SESSION_PAYLOAD" | (cd "$REPO_R10" && bash "$HOOK" 2>&1 >/dev/null) || true)
branch_after=$(git -C "$REPO_R10" symbolic-ref --short HEAD 2>/dev/null || echo "unknown")
if echo "$hook_err" | grep -q "branch-guard" && [ "$branch_after" = "main" ]; then
  pass "Row 10: SessionStart on off-main branch → warning emitted, HEAD restored to main"
else
  fail "Row 10: SessionStart should warn and restore main (got stderr='$hook_err', branch='$branch_after')"
fi

run_hook_full "$MAIN_R4" ""
# Exit status guards liveness; content guards no-op behavior.  Both must hold:
# a dead hook also produces empty stdout and would pass the content check alone.
if ! is_live "$_st" "$_err"; then
  fail "Row 11: empty stdin → LIVENESS FAIL (exit=$_st stderr='$_err')"
elif ! is_blocked "$_out"; then
  pass "Row 11: empty stdin → no-op, no block"
else
  fail "Row 11: empty stdin should be no-op (content check: got '$_out')"
fi

run_hook_full "$MAIN_R4" '{"broken json'
# Exit status guards liveness; content guards no-op behavior.  Both must hold:
# a dead hook also produces empty stdout and would pass the content check alone.
if ! is_live "$_st" "$_err"; then
  fail "Row 12: malformed JSON → LIVENESS FAIL (exit=$_st stderr='$_err')"
elif ! is_blocked "$_out"; then
  pass "Row 12: malformed JSON → no-op, no block"
else
  fail "Row 12: malformed JSON should be no-op (content check: got '$_out')"
fi

# ── Degrade message rows ──────────────────────────────────────────────────────

# Git shims used by rows 13 and 15 only.  Every other row continues to see real
# git via the unmodified PATH.  Both shims live inside WORK_DIR and are cleaned
# up by the existing trap.
#
# Shim r13: simulates git < 2.31 — any rev-parse call that includes
# --path-format=absolute exits 1 with no output; all other calls reach real git.
mkdir -p "$WORK_DIR/shim-r13"
cat > "$WORK_DIR/shim-r13/git" << SHIM_R13
#!/usr/bin/env bash
for arg in "\$@"; do
  [ "\$arg" = "--path-format=absolute" ] && exit 1
done
exec "$REAL_GIT" "\$@"
SHIM_R13
chmod +x "$WORK_DIR/shim-r13/git"

# Shim r15: lets --git-common-dir reach real git but exits 1 on --git-dir,
# reproducing the state where only the second rev-parse fails.
mkdir -p "$WORK_DIR/shim-r15"
cat > "$WORK_DIR/shim-r15/git" << SHIM_R15
#!/usr/bin/env bash
for arg in "\$@"; do
  [ "\$arg" = "--git-dir" ] && exit 1
done
exec "$REAL_GIT" "\$@"
SHIM_R15
chmod +x "$WORK_DIR/shim-r15/git"

# Row 13: degrade branch A fires, branch B absent.
# The shim-r13 PATH prefix intercepts any rev-parse call that includes
# --path-format=absolute and exits 1 with no output (simulating git < 2.31).
# --is-inside-work-tree is NOT intercepted: it reaches real git, which exits 0
# because MAIN_R4 is a genuine repository.  With a="" and b="" the hook's ||
# guard triggers; --is-inside-work-tree exits 0 → branch A message emitted.
err=$(printf '%s' "$PAYLOAD" | (cd "$MAIN_R4" && PATH="$WORK_DIR/shim-r13:$PATH" bash "$HOOK" 2>&1 >/dev/null) || true)
if echo "$err" | grep -q "returned nothing" && ! echo "$err" | grep -q "not a git repository"; then
  pass "Row 13: degrade branch A fires, branch B absent (--path-format shimmed away)"
else
  fail "Row 13: expected branch A message only (got: '$err')"
fi

# Row 14: degrade branch B fires, branch A absent.
# Fixture: stale worktree variant A — .git pointer file deleted.
# Git sees no .git entry → not a git repository → branch B.
err=$(run_hook_err "$WT_R14" || true)
if echo "$err" | grep -q "not a git repository" && ! echo "$err" | grep -q "returned nothing"; then
  pass "Row 14: degrade branch B fires, branch A absent (deleted .git pointer)"
else
  fail "Row 14: expected branch B message only (got: '$err')"
fi

# Row 15: only the SECOND rev-parse fails → diagnostic emitted, dir not exempted.
# The shim-r15 PATH prefix passes --git-common-dir through to real git (so a is
# set to a real path) but exits 1 on --git-dir (so b="").  With a non-empty and
# b empty the hook's || guard fires; --is-inside-work-tree exits 0 in MAIN_R4
# → branch A diagnostic on stderr.  The hook does NOT exit 0 (no exemption) →
# the PreToolUse payload produces a block decision on stdout.
err_r15=$(printf '%s' "$PAYLOAD" | (cd "$MAIN_R4" && PATH="$WORK_DIR/shim-r15:$PATH" bash "$HOOK" 2>&1 >/dev/null) || true)
out_r15=$(printf '%s' "$PAYLOAD" | (cd "$MAIN_R4" && PATH="$WORK_DIR/shim-r15:$PATH" bash "$HOOK" 2>/dev/null) || true)
if echo "$err_r15" | grep -q "returned nothing" && is_blocked "$out_r15"; then
  pass "Row 15: second rev-parse fails → diagnostic emitted and dir not exempted"
else
  fail "Row 15: expected branch-A diagnostic on stderr and block JSON on stdout (stderr='$err_r15' stdout='$out_r15')"
fi

# Row 16: stale worktree variant B → branch B fires, branch A absent.
# The .git pointer file exists but the backing metadata directory has been deleted.
# Per spec: IF THIS ROW DOES NOT LAND ON BRANCH B — STOP AND REPORT.
err=$(run_hook_err "$WT_R16" || true)
if echo "$err" | grep -q "not a git repository" && ! echo "$err" | grep -q "returned nothing"; then
  pass "Row 16: stale worktree variant B → branch B fires, branch A absent"
else
  echo ""
  echo "!!! Row 16 DID NOT LAND ON BRANCH B — this is a real silent-misclassification defect !!!"
  echo "    stderr was: '$err'"
  echo "    Stopping as instructed."
  echo ""
  fail "Row 16: expected branch B, got: '$err'"
  echo ""
  echo "Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped"
  exit 1
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "All branch-guard tests passed."
