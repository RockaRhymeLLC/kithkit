#!/usr/bin/env python3
"""
GitHub Rate Check — PreToolUse hook
Blocks gh pr/issue create to external repos if rate limit exceeded.
Part of the cross-agent GitHub TOS compliance system.
"""

import json
import sys
import os
from datetime import datetime, timedelta
from pathlib import Path

# Config
RATE_LIMIT = 3  # Max writes per hour to external repos
RATE_WINDOW_HOURS = 1
OUR_ORGS = {"rockarymellc", "rockaryhme", "hurleyworks"}  # Case-insensitive
LEDGER_FILE = Path.home() / "cc4me_r2d2/.claude/state/github-rate-ledger/external-writes.jsonl"

def is_external_repo(repo: str) -> bool:
    """Check if repo is external (not ours)."""
    if not repo:
        return False
    # Handle org/repo format
    org = repo.split("/")[0].lower() if "/" in repo else ""
    return org not in OUR_ORGS

def is_rate_limited_command(command: str) -> tuple[bool, str, str]:
    """
    Check if command is a rate-limited GitHub write.
    Returns (is_limited, action, repo).
    """
    if not command:
        return False, "", ""

    parts = command.split()
    if len(parts) < 3:
        return False, "", ""

    if parts[0] != "gh":
        return False, "", ""

    # gh pr create
    if parts[1] == "pr" and parts[2] == "create":
        # Try to extract repo from -R or --repo flag
        repo = ""
        for i, p in enumerate(parts):
            if p in ("-R", "--repo") and i + 1 < len(parts):
                repo = parts[i + 1]
                break
        return True, "pr_create", repo

    # gh issue create
    if parts[1] == "issue" and parts[2] == "create":
        repo = ""
        for i, p in enumerate(parts):
            if p in ("-R", "--repo") and i + 1 < len(parts):
                repo = parts[i + 1]
                break
        return True, "issue_create", repo

    return False, "", ""

def count_recent_writes() -> int:
    """Count writes in the rate window from the shared ledger."""
    if not LEDGER_FILE.exists():
        return 0

    cutoff = datetime.utcnow() - timedelta(hours=RATE_WINDOW_HOURS)
    count = 0

    try:
        with open(LEDGER_FILE) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    ts = datetime.fromisoformat(entry["timestamp"].replace("+00:00", "").replace("Z", ""))
                    if ts > cutoff:
                        count += 1
                except (json.JSONDecodeError, KeyError, ValueError):
                    continue
    except IOError:
        pass

    return count

def main():
    # Read hook input
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)  # Can't parse, allow

    # Only check Bash tool
    if hook_input.get("tool_name") != "Bash":
        sys.exit(0)

    command = hook_input.get("tool_input", {}).get("command", "")

    # Check if this is a rate-limited command
    is_limited, action, repo = is_rate_limited_command(command)
    if not is_limited:
        sys.exit(0)

    # Skip if it's our own repo
    if repo and not is_external_repo(repo):
        sys.exit(0)

    # Check for override
    if os.environ.get("GITHUB_RATE_OVERRIDE") == "1":
        sys.exit(0)

    # Count recent writes
    recent = count_recent_writes()

    if recent >= RATE_LIMIT:
        # Block the command
        result = {
            "decision": "block",
            "reason": f"GitHub rate limit: {recent}/{RATE_LIMIT} external writes in the last hour. Wait or set GITHUB_RATE_OVERRIDE=1 to bypass."
        }
        print(json.dumps(result))
        sys.exit(0)

    # Allow
    sys.exit(0)

if __name__ == "__main__":
    main()
