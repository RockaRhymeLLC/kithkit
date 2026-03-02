# GitHub Rate Limiting Hooks

Prevent bulk GitHub write operations (PR creation, issue filing) by Claude Code agents using PreToolUse and PostToolUse hooks. The hooks maintain a rolling ledger of writes and block new ones when the hourly limit is reached.

## Prerequisites

- Claude Code with hooks support
- Python 3.8+
- `gh` CLI authenticated

## Setup

```bash
# 1. Create the hooks directory and state directory
mkdir -p ~/.config/kithkit/hooks
mkdir -p ~/.local/share/kithkit/github-rate

# 2. Copy hook scripts (paths below must be absolute)
cp github-rate-check.py  ~/.config/kithkit/hooks/github-rate-check.py
cp github-rate-log.py    ~/.config/kithkit/hooks/github-rate-log.py
chmod +x ~/.config/kithkit/hooks/github-rate-check.py
chmod +x ~/.config/kithkit/hooks/github-rate-log.py

# 3. Initialize the ledger file
echo '{"entries":[]}' > ~/.local/share/kithkit/github-rate/ledger.json

# 4. Register hooks in .claude/settings.json (see snippet below)

# 5. Test: trigger a deny by temporarily setting MAX_WRITES_PER_HOUR=0
MAX_WRITES_PER_HOUR=0 python3 ~/.config/kithkit/hooks/github-rate-check.py <<'EOF'
{"tool": "Bash", "input": {"command": "gh pr create --title test --body test"}}
EOF
```

## Hook Registration

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.config/kithkit/hooks/github-rate-check.py"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.config/kithkit/hooks/github-rate-log.py"
          }
        ]
      }
    ]
  }
}
```

Note: the matcher is `"Bash"` with a capital B — it matches the tool name, not the shell command.

## Ledger Format

```json
{
  "entries": [
    {
      "timestamp": "2026-02-25T14:32:00Z",
      "action": "gh pr create",
      "repo": "your-org/your-repo",
      "agent": "worker-abc123"
    }
  ]
}
```

Entries older than 24 hours are pruned by `github-rate-log.py` on every write. The rolling 1-hour window check in `github-rate-check.py` only counts entries within the last 60 minutes.

## Reference Code: github-rate-check.py (PreToolUse)

```python
#!/usr/bin/env python3
"""
PreToolUse hook — blocks gh pr create / gh issue create when hourly limit is reached.
Claude Code passes hook input as JSON on stdin; output JSON is read for permissionDecision.
"""
import sys
import json
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

MAX_WRITES_PER_HOUR = int(os.environ.get('MAX_WRITES_PER_HOUR', '3'))
STATE_DIR = Path(os.environ.get('STATE_DIR', os.path.expanduser('~/.local/share/kithkit/github-rate')))
LEDGER_PATH = STATE_DIR / 'ledger.json'

# Repos under these orgs are exempt from the rate limit
OUR_ORGS = {'RockaRhymeLLC', 'bmo-internal'}

# Patterns that constitute a GitHub write operation
WRITE_PATTERNS = [
    re.compile(r'\bgh\s+pr\s+create\b'),
    re.compile(r'\bgh\s+issue\s+create\b'),
]


def is_write_command(command: str) -> bool:
    return any(p.search(command) for p in WRITE_PATTERNS)


def extract_repo(command: str) -> str | None:
    """Best-effort repo extraction from --repo flag or gh context."""
    m = re.search(r'--repo\s+([^\s]+)', command)
    return m.group(1) if m else None


def is_exempt(repo: str | None) -> bool:
    """Our own org repos are exempt — we trust ourselves."""
    if not repo:
        return False
    org = repo.split('/')[0]
    return org in OUR_ORGS


def count_recent_writes(entries: list, window_minutes: int = 60) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    return sum(
        1 for e in entries
        if datetime.fromisoformat(e['timestamp']) > cutoff
    )


def main():
    payload = json.loads(sys.stdin.read())

    # Only inspect Bash tool calls
    if payload.get('tool') != 'Bash':
        print(json.dumps({}))
        return

    command = payload.get('input', {}).get('command', '')

    if not is_write_command(command):
        print(json.dumps({}))
        return

    # Override env var allows a single explicit bypass
    if os.environ.get('GITHUB_RATE_OVERRIDE') == '1':
        print(json.dumps({}))
        return

    repo = extract_repo(command)
    if is_exempt(repo):
        print(json.dumps({}))
        return

    # Load ledger and count recent writes
    try:
        ledger = json.loads(LEDGER_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        ledger = {'entries': []}

    recent = count_recent_writes(ledger['entries'])

    if recent >= MAX_WRITES_PER_HOUR:
        print(json.dumps({
            'permissionDecision': 'deny',
            'denyReason': (
                f'GitHub rate limit reached: {recent}/{MAX_WRITES_PER_HOUR} writes in the last hour. '
                f'Set GITHUB_RATE_OVERRIDE=1 to bypass, or wait for the window to roll over.'
            ),
        }))
    else:
        print(json.dumps({}))


if __name__ == '__main__':
    main()
```

## Reference Code: github-rate-log.py (PostToolUse)

```python
#!/usr/bin/env python3
"""
PostToolUse hook — logs successful gh pr/issue create commands to the ledger.
Prunes entries older than 24 hours on every write.
"""
import sys
import json
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

STATE_DIR = Path(os.environ.get('STATE_DIR', os.path.expanduser('~/.local/share/kithkit/github-rate')))
LEDGER_PATH = STATE_DIR / 'ledger.json'
PRUNE_AFTER_HOURS = 24

WRITE_PATTERNS = [
    re.compile(r'\bgh\s+pr\s+create\b'),
    re.compile(r'\bgh\s+issue\s+create\b'),
]


def extract_repo(command: str) -> str | None:
    m = re.search(r'--repo\s+([^\s]+)', command)
    return m.group(1) if m else None


def extract_action(command: str) -> str:
    if re.search(r'\bgh\s+pr\s+create\b', command):
        return 'gh pr create'
    if re.search(r'\bgh\s+issue\s+create\b', command):
        return 'gh issue create'
    return 'gh write'


def main():
    payload = json.loads(sys.stdin.read())

    if payload.get('tool') != 'Bash':
        return

    command = payload.get('input', {}).get('command', '')
    exit_code = payload.get('output', {}).get('exitCode', 1)

    # Only log successful writes
    if not any(p.search(command) for p in WRITE_PATTERNS):
        return
    if exit_code != 0:
        return

    # Load, prune, append, save
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        ledger = json.loads(LEDGER_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        ledger = {'entries': []}

    cutoff = datetime.now(timezone.utc) - timedelta(hours=PRUNE_AFTER_HOURS)
    ledger['entries'] = [
        e for e in ledger['entries']
        if datetime.fromisoformat(e['timestamp']) > cutoff
    ]

    ledger['entries'].append({
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'action': extract_action(command),
        'repo': extract_repo(command),
        'agent': os.environ.get('CLAUDE_AGENT_ID', 'unknown'),
    })

    LEDGER_PATH.write_text(json.dumps(ledger, indent=2))


if __name__ == '__main__':
    main()
```

## Override Mechanism

Set `GITHUB_RATE_OVERRIDE=1` in the environment to bypass the rate check for a single command. This is intentionally not a config option — it should require an explicit, visible override:

```bash
GITHUB_RATE_OVERRIDE=1 gh pr create --title "Emergency fix" --body "..."
```

The override does not suppress PostToolUse logging — the write is still recorded in the ledger.

## Troubleshooting

**Hook not firing**
Verify `.claude/settings.json` is valid JSON (syntax errors silently disable all hooks). The matcher must be `"Bash"` with a capital B — it matches the Claude Code tool name, not the shell. Check with:
```bash
python3 -m json.tool .claude/settings.json
```

**False positives (legitimate writes blocked)**
Add the repo's org to `OUR_ORGS` in `github-rate-check.py`, or use `GITHUB_RATE_OVERRIDE=1` for the specific command. If a whole class of repos should always be exempt, extend the `is_exempt` function with additional logic (e.g., check if the repo is a personal fork).

**Ledger not persisting between sessions**
Check that `STATE_DIR` resolves to a writable absolute path. The default `~/.local/share/kithkit/github-rate` expands correctly for the user running Claude Code. If you override `STATE_DIR` via environment, ensure it is set consistently across all sessions. Verify:
```bash
ls -la ~/.local/share/kithkit/github-rate/ledger.json
```

**Peer agent coordination (multiple agents sharing the ledger)**
All agents on the same machine share the same `STATE_DIR`. The ledger is not write-locked — concurrent writes from multiple agents can race. For low-frequency writes (a few per hour) this is acceptable. If you need strict coordination, wrap the ledger read/write in a file lock using `fcntl.flock`.

**PostToolUse not logging (writes happening but not counted)**
The PostToolUse hook receives `exitCode` in `payload['output']['exitCode']`. Confirm the `gh` command is actually succeeding (exit code 0). Run the hook manually:
```bash
echo '{"tool":"Bash","input":{"command":"gh pr create --repo org/repo"},"output":{"exitCode":0}}' \
  | python3 ~/.config/kithkit/hooks/github-rate-log.py
cat ~/.local/share/kithkit/github-rate/ledger.json
```
