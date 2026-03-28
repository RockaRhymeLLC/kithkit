# GitHub Rate Limiting Hooks

Prevent accidental bulk GitHub write operations — PR creation, issue filing, comment floods — that could violate GitHub's Terms of Service or spam repositories you don't own. This recipe uses Claude Code's PreToolUse and PostToolUse hooks to intercept and log `gh` CLI calls before they reach GitHub.

---

## Prerequisites

- Claude Code hooks support (see [hooks documentation](https://code.claude.com/docs/en/hooks))
- Python 3.8+ (`python3 --version`)
- `gh` CLI installed and authenticated (`gh auth status`)
- Kithkit project with `.kithkit/` directory at the repo root

---

## Setup Steps

### 1. Create the hook scripts directory

```bash
mkdir -p .kithkit/hooks
```

### 2. Create the PreToolUse rate-check script

Copy the reference code below into `.kithkit/hooks/github-rate-check.py` and make it executable:

```bash
chmod +x .kithkit/hooks/github-rate-check.py
```

### 3. Create the PostToolUse rate-log script

Copy the reference code below into `.kithkit/hooks/github-rate-log.py` and make it executable:

```bash
chmod +x .kithkit/hooks/github-rate-log.py
```

### 4. Register hooks in `.kithkit/settings.json`

See the Hook Registration snippet below. Edit `.kithkit/settings.json` — this is the authoritative copy. Kithkit syncs it to `.claude/settings.json` automatically so Claude Code picks it up.

### 5. Configure your org allowlist

Open `github-rate-check.py` and populate `OUR_ORGS` with your own GitHub organization names. Repos under these orgs are exempt from rate limiting (internal work, not external spam risk):

```python
OUR_ORGS = {'my-org', 'my-other-org'}
```

### 6. Initialize the ledger file

```bash
mkdir -p .kithkit/state
echo '{"entries":[]}' > .kithkit/state/github-rate-ledger.json
```

---

## Reference Code

### PreToolUse Hook — Rate Check (`github-rate-check.py`)

```python
#!/usr/bin/env python3
"""PreToolUse hook — rate-limits GitHub write operations.

Reads hook input from stdin (JSON), writes decision to stdout (JSON).
Exit 0 always — block via permissionDecision, not exit code.
"""
import sys
import json
import os
import time
import re

MAX_WRITES_PER_HOUR = 3

STATE_DIR = os.environ.get('STATE_DIR', '.kithkit/state')
LEDGER_PATH = os.path.join(STATE_DIR, 'github-rate-ledger.json')

# GitHub orgs you own — repos under these are exempt from the rate limit.
# Add your own org names here.
OUR_ORGS: set[str] = set()

# Set GITHUB_RATE_OVERRIDE=1 in your environment to bypass the limit.
OVERRIDE = os.environ.get('GITHUB_RATE_OVERRIDE', '0') == '1'


def load_ledger() -> dict:
    try:
        with open(LEDGER_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {'entries': []}


def extract_repo(command: str) -> str | None:
    """Extract owner/repo from a gh CLI command, if present."""
    match = re.search(r'-R\s+([^\s]+)', command) or re.search(r'--repo\s+([^\s]+)', command)
    if match:
        return match.group(1)
    # gh pr/issue create in a git repo defaults to the current remote — unknown here
    return None


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = hook_input.get('tool_name', '')
    tool_input = hook_input.get('tool_input', {})

    # Only intercept Bash tool calls
    if tool_name != 'Bash':
        sys.exit(0)

    command = tool_input.get('command', '')

    # Only check calls that create PRs or issues
    if not re.search(r'gh\s+(pr|issue)\s+create', command):
        sys.exit(0)

    # Exempt internal repos
    repo = extract_repo(command)
    if repo:
        org = repo.split('/')[0]
        if org in OUR_ORGS:
            sys.exit(0)

    # Override flag — bypass rate limit (use sparingly)
    if OVERRIDE:
        output = {
            'additionalContext': 'GITHUB_RATE_OVERRIDE is set — skipping rate check.'
        }
        json.dump(output, sys.stdout)
        sys.exit(0)

    # Count recent writes in the past hour
    ledger = load_ledger()
    now = time.time()
    recent = [e for e in ledger.get('entries', []) if now - e.get('timestamp', 0) < 3600]
    count = len(recent)

    if count >= MAX_WRITES_PER_HOUR:
        output = {
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'deny',
            },
            'additionalContext': (
                f'GitHub rate limit: {count}/{MAX_WRITES_PER_HOUR} write operations '
                f'used in the last hour. Wait before creating more PRs or issues, '
                f'or set GITHUB_RATE_OVERRIDE=1 to bypass.'
            ),
        }
        json.dump(output, sys.stdout)
    elif count >= MAX_WRITES_PER_HOUR - 1:
        output = {
            'additionalContext': (
                f'GitHub rate warning: {count}/{MAX_WRITES_PER_HOUR} writes used. '
                f'This is your last allowed write this hour.'
            ),
        }
        json.dump(output, sys.stdout)
    # else: within limit, no output needed (Claude Code proceeds normally)


if __name__ == '__main__':
    main()
```

### PostToolUse Hook — Rate Log (`github-rate-log.py`)

```python
#!/usr/bin/env python3
"""PostToolUse hook — logs successful GitHub write operations to the ledger.

Called after a Bash tool invocation completes. Records PRs and issues created
so the PreToolUse hook can enforce the hourly rate limit.
"""
import sys
import json
import os
import time
import re

STATE_DIR = os.environ.get('STATE_DIR', '.kithkit/state')
LEDGER_PATH = os.path.join(STATE_DIR, 'github-rate-ledger.json')
AGENT_NAME = os.environ.get('AGENT_NAME', 'assistant')

# Prune entries older than this (seconds). 24h keeps daily audit trail.
PRUNE_AGE = 86400


def load_ledger() -> dict:
    try:
        with open(LEDGER_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {'entries': []}


def save_ledger(ledger: dict) -> None:
    os.makedirs(os.path.dirname(LEDGER_PATH), exist_ok=True)
    with open(LEDGER_PATH, 'w') as f:
        json.dump(ledger, f, indent=2)


def extract_repo(command: str) -> str:
    match = re.search(r'-R\s+([^\s]+)', command) or re.search(r'--repo\s+([^\s]+)', command)
    return match.group(1) if match else 'unknown'


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = hook_input.get('tool_name', '')
    if tool_name != 'Bash':
        sys.exit(0)

    tool_input = hook_input.get('tool_input', {})
    command = tool_input.get('command', '')

    # Detect action type
    pr_match = re.search(r'gh\s+pr\s+create', command)
    issue_match = re.search(r'gh\s+issue\s+create', command)

    if not pr_match and not issue_match:
        sys.exit(0)

    # Only log if the command succeeded (exit code 0)
    tool_output = hook_input.get('tool_response', {})
    if tool_output.get('exitCode', 0) != 0:
        sys.exit(0)

    action = 'pr_create' if pr_match else 'issue_create'
    repo = extract_repo(command)

    ledger = load_ledger()
    ledger.setdefault('entries', []).append({
        'timestamp': time.time(),
        'action': action,
        'repo': repo,
        'agent': AGENT_NAME,
    })

    # Prune old entries
    now = time.time()
    ledger['entries'] = [
        e for e in ledger['entries']
        if now - e.get('timestamp', 0) < PRUNE_AGE
    ]

    save_ledger(ledger)


if __name__ == '__main__':
    main()
```

### Ledger Format

The ledger file lives at `.kithkit/state/github-rate-ledger.json` and is maintained automatically by the PostToolUse hook. Each entry records one write operation:

```json
{
  "entries": [
    {
      "timestamp": 1708646400,
      "action": "pr_create",
      "repo": "owner/repo",
      "agent": "assistant"
    },
    {
      "timestamp": 1708647200,
      "action": "issue_create",
      "repo": "other-owner/other-repo",
      "agent": "assistant"
    }
  ]
}
```

- `timestamp`: Unix epoch (seconds). Used for the 1-hour sliding window.
- `action`: `pr_create` or `issue_create`.
- `repo`: `owner/repo` extracted from the `gh` command, or `"unknown"` if not determinable.
- `agent`: Value of the `AGENT_NAME` environment variable (useful in multi-agent setups).

Entries older than 24 hours are pruned automatically on each write.

### Hook Registration

Add or merge this into `.kithkit/settings.json` (the authoritative copy — Kithkit syncs it to `.claude/settings.json` automatically):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .kithkit/hooks/github-rate-check.py"
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
            "command": "python3 .kithkit/hooks/github-rate-log.py"
          }
        ]
      }
    ]
  }
}
```

Both hooks match all `Bash` tool calls and filter internally by command content — this keeps the matcher simple and avoids complex regex in settings.

---

## Config Snippet

There is no daemon config required for this recipe — it operates entirely through Claude Code hooks and a local ledger file. The only configuration is inline in the hook scripts:

```python
# In github-rate-check.py

# Maximum GitHub write operations (PRs + issues) per rolling hour
MAX_WRITES_PER_HOUR = 3

# Your GitHub orgs — repos under these are exempt from rate limiting
OUR_ORGS: set[str] = {'your-org', 'your-other-org'}
```

To change limits without editing the script, you can move these to a JSON config file read at hook runtime — see the Troubleshooting section.

---

## Override

To bypass the rate limit for a single session (use sparingly — the limit exists to protect you):

```bash
export GITHUB_RATE_OVERRIDE=1
```

Unset it when done:

```bash
unset GITHUB_RATE_OVERRIDE
```

The override is logged in the `additionalContext` output so you have an audit trail.

---

## Troubleshooting

**Hook not firing at all**

- Confirm `.kithkit/settings.json` exists and is valid JSON: `python3 -m json.tool .kithkit/settings.json`
- The `matcher` field must be `"Bash"` (capital B) — it matches the tool name exactly
- Restart Claude Code after editing `settings.json`
- Check that both hook scripts are executable: `ls -l .kithkit/hooks/`

**False positives (legitimate commands being blocked)**

- Refine the command regex in `github-rate-check.py` — the current pattern `gh\s+(pr|issue)\s+create` is intentionally broad
- Add the relevant org to `OUR_ORGS` to exempt internal repos
- For a one-off, use `GITHUB_RATE_OVERRIDE=1`

**Ledger not persisting between sessions**

- Confirm `STATE_DIR` resolves to a writable path. The default is `.kithkit/state` relative to cwd — if Claude Code changes directory, the path may differ
- Set `STATE_DIR` as an absolute path in your shell profile or launchd plist:
  ```bash
  export STATE_DIR="/absolute/path/to/your/project/.kithkit/state"
  ```
- Check write permissions: `ls -la .kithkit/state/`

**Peer agent coordination**

In multi-agent setups, each agent maintains its own ledger. To enforce a shared rate limit across agents, have each agent broadcast its ledger entries to peers via agent-comms after a write, and merge incoming entries into the local ledger before the rate check. The `agent` field on each entry identifies the source.

**PostToolUse hook not logging**

- Confirm the `gh` command actually succeeded — the log hook checks `exitCode == 0` and skips failed commands
- Test manually by piping a sample payload: `echo '{"tool_name":"Bash","tool_input":{"command":"gh pr create"},"tool_response":{"exitCode":0}}' | python3 .kithkit/hooks/github-rate-log.py`
