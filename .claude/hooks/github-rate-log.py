#!/usr/bin/env python3
"""
GitHub Rate Log — PostToolUse hook
Logs and broadcasts GitHub writes to external repos.
Part of the cross-agent GitHub TOS compliance system.
"""

import json
import sys
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# Config
OUR_ORGS = {"rockarymellc", "rockaryhme", "hurleyworks"}  # Case-insensitive
LEDGER_FILE = Path.home() / "cc4me_r2d2/.claude/state/github-rate-ledger/external-writes.jsonl"
AGENT_NAME = "r2d2"

def is_external_repo(repo: str) -> bool:
    """Check if repo is external (not ours)."""
    if not repo:
        return True  # Assume external if unknown
    org = repo.split("/")[0].lower() if "/" in repo else ""
    return org not in OUR_ORGS

def parse_github_command(command: str) -> tuple[str, str]:
    """
    Parse a GitHub command to extract action and repo.
    Returns (action, repo) or ("", "") if not a tracked command.
    """
    if not command:
        return "", ""

    parts = command.split()
    if len(parts) < 3 or parts[0] != "gh":
        return "", ""

    action = ""
    repo = ""

    # Extract repo from -R/--repo flag
    for i, p in enumerate(parts):
        if p in ("-R", "--repo") and i + 1 < len(parts):
            repo = parts[i + 1]
            break

    # Identify action
    if parts[1] == "pr" and parts[2] == "create":
        action = "pr_create"
    elif parts[1] == "issue" and parts[2] == "create":
        action = "issue_create"

    return action, repo

def broadcast_to_peer(entry: dict):
    """Broadcast rate ledger entry to BMO via agent-comms."""
    try:
        msg = f"[RATE-LEDGER] {json.dumps(entry)}"
        script = Path.home() / "cc4me_r2d2/scripts/agent-send.sh"
        if script.exists():
            subprocess.run(
                [str(script), "bmo", msg],
                timeout=10,
                capture_output=True
            )
    except Exception:
        pass  # Best effort

def main():
    # Read hook input
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    # Only process Bash tool
    if hook_input.get("tool_name") != "Bash":
        sys.exit(0)

    # Only log successful commands
    result = hook_input.get("tool_result", {})
    if result.get("exit_code", 1) != 0:
        sys.exit(0)

    command = hook_input.get("tool_input", {}).get("command", "")
    action, repo = parse_github_command(command)

    if not action:
        sys.exit(0)

    # Skip our own repos
    if repo and not is_external_repo(repo):
        sys.exit(0)

    # Create ledger entry
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "repo": repo or "unknown",
        "agent": AGENT_NAME
    }

    # Ensure ledger directory exists
    LEDGER_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Append to local ledger
    try:
        with open(LEDGER_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except IOError:
        pass

    # Broadcast to peer
    broadcast_to_peer(entry)

    sys.exit(0)

if __name__ == "__main__":
    main()
