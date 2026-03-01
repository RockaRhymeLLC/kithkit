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

# Workers run inside .claude/worktrees/ — exempt from the guard
if [[ "$PWD" == */.claude/worktrees/* ]]; then
  exit 0
fi

# Read stdin (may be empty for SessionStart, or JSON for PreToolUse)
INPUT=""
if [[ -p /dev/stdin ]]; then
  INPUT=$(cat)
fi

# ── Detect mode from stdin content ────────────────────────────
# If stdin has tool_name JSON, we're in PreToolUse mode.
# Otherwise, SessionStart mode.

if [[ -n "$INPUT" ]] && echo "$INPUT" | python3 -c "import sys,json; json.load(sys.stdin).get('tool_name')" 2>/dev/null; then
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
    if re.match(r"-[bB]\b", args):
        continue
    if re.match(r"-[cC]\b", args):
        continue
    first_arg = args.split()[0] if args.split() else ""
    if first_arg == "main":
        continue
    tokens = [t for t in args.split() if t]
    if tokens and all(t.startswith("-") for t in tokens):
        continue

    result = {
        "decision": "block",
        "reason": "Branch guard: comms/orchestrator sessions must stay on main. "
                  "Use a worker in a worktree for feature branch work."
    }
    print(json.dumps(result))
    sys.exit(0)

sys.exit(0)
'
else
  # ── SessionStart mode ────────────────────────────────────────
  BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)
  if [[ -n "$BRANCH" && "$BRANCH" != "main" ]]; then
    echo "[branch-guard] WARNING: session on '$BRANCH' instead of main — switching back." >&2
    git checkout main 2>&1
  fi
fi
