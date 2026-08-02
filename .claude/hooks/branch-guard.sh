#!/usr/bin/env bash
# branch-guard.sh — Prevents comms and orchestrator sessions from leaving main.
#
# Dual-mode hook:
#   1. SessionStart: checks current branch on session init, switches back to main if drifted
#   2. PreToolUse (Bash): inspects commands for git checkout/switch that would leave main
#
# Workers in git worktrees are exempt — they operate on feature branches by design.
# Hook protocol: output JSON {"decision":"block","reason":"..."} to block, or exit 0 to allow.

set -euo pipefail

# Topology test: a genuine linked worktree has --git-common-dir pointing to the
# shared .git of the main repo, while --git-dir points to the worktree-specific
# subdirectory inside .git/worktrees/. When both are non-empty AND different, this
# CWD is inside a linked worktree. Two path-substring approaches were rejected:
# (1) testing GITDIR against */worktrees/* fails when the main repo itself lives
# under a path containing "worktrees"; (2) testing $PWD with a path-glob exempts
# any non-worktree directory whose path happens to contain the substring. Both
# infer topology from directory names rather than from what git actually knows.
a=""
b=""
if a=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
   && b=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) \
   && [ -n "$a" ] && [ "$a" != "$b" ]; then
  exit 0
fi
# Degrade loudly when the rev-parse pair returned no usable answer.
# The OR covers two distinct failure modes:
#   (1) both calls failed (git < 2.31, --path-format unsupported; or totally outside git)
#   (2) only the second call failed — previously silent fall-through, now diagnosed.
# Branch (B) is decided by --is-inside-work-tree exit status, NOT by .git file/dir
# presence: a dangling-pointer worktree has a .git file but is not in a work tree.
if [ -z "$a" ] || [ -z "$b" ]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "branch-guard: git rev-parse --path-format returned nothing; worktree exemption disabled (requires git >= 2.31, or the worktree registration is broken)" >&2
  else
    echo "branch-guard: not a git repository; worktree exemption not applicable" >&2
  fi
fi

# Read stdin (may be empty for SessionStart, or JSON for PreToolUse)
INPUT=""
if [[ -p /dev/stdin ]]; then
  INPUT=$(cat)
fi

# ── Detect mode from hook_event_name in stdin JSON ────────────
# Claude Code always sends hook_event_name in the hook payload. Any input that
# doesn't parse, or doesn't declare a recognized event, is treated as a no-op —
# the forced `git checkout main` is only reachable from an explicit SessionStart
# event, never as a fallthrough default.
MODE=""
if [[ -n "$INPUT" ]]; then
  MODE=$(echo "$INPUT" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get("hook_event_name", ""))
except (json.JSONDecodeError, ValueError):
    print("")
' 2>/dev/null || true)
fi

if [[ "$MODE" == "PreToolUse" ]]; then
  # ── PreToolUse mode ──────────────────────────────────────────
  echo "$INPUT" | python3 -c '
import json, sys, re

try:
    hook_input = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

if hook_input.get("tool_name") != "Bash":
    sys.exit(0)

command = hook_input.get("tool_input", {}).get("command", "")
if not command:
    sys.exit(0)

cmd = " ".join(command.split())
subcmds = re.split(r"[;&|]+", cmd)

for sub in subcmds:
    sub = sub.strip()
    m = re.match(r"(?:.*?\s)?git\s+(checkout|switch)\s+(.*)", sub)
    if not m:
        continue

    args = m.group(2).strip()
    if not args:
        continue
    if args.startswith("-- "):
        continue
    if args == ".":
        continue
    first_arg = args.split()[0] if args.split() else ""
    if first_arg == "main":
        continue
    tokens = [t for t in args.split() if t]
    if tokens and all(t.startswith("-") for t in tokens):
        continue

    reason = "Branch guard: comms/orchestrator sessions must stay on main. "
    if re.match(r"-[bBcC]\b", args):
        reason += "Branch creation is also forbidden — use a worker in a worktree."
    else:
        reason += "Use a worker in a worktree for feature branch work."
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)

sys.exit(0)
'
elif [[ "$MODE" == "SessionStart" ]]; then
  # ── SessionStart mode ────────────────────────────────────────
  BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)
  if [[ -n "$BRANCH" && "$BRANCH" != "main" ]]; then
    echo "[branch-guard] WARNING: session on '$BRANCH' instead of main — switching back." >&2
    git checkout main 2>&1
  fi
else
  # Empty stdin, unparseable JSON, or an event we don't act on — no-op.
  exit 0
fi
