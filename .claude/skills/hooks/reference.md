# Hooks Reference

Comprehensive reference for Claude Code hooks configuration, input/output schemas, and advanced patterns.

**Official Documentation**: https://code.claude.com/docs/en/hooks

## Hook Lifecycle

Hooks fire at specific points during a Claude Code session:

1. **SessionStart** - Session begins or resumes
2. **UserPromptSubmit** - User submits prompt
3. **PreToolUse** - Before tool execution
4. **PermissionRequest** - Permission dialog appears
5. **PostToolUse** / **PostToolUseFailure** - After tool completes
6. **SubagentStart** / **SubagentStop** - Subagent lifecycle
7. **Stop** - Claude finishes responding
8. **PreCompact** - Before context compaction
9. **SessionEnd** - Session terminates

## Configuration Files

| Location | Path | Scope |
|----------|------|-------|
| User | `~/.claude/settings.json` | All projects |
| Project | `.claude/settings.json` | This project |
| Local | `.claude/settings.local.json` | This project (not committed) |
| Plugin | `<plugin>/hooks/hooks.json` | Where plugin enabled |

## Complete Hook Structure

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

### Fields

| Field | Description |
|-------|-------------|
| `matcher` | Pattern to match tool names (exact, regex, or `*` for all) |
| `type` | `"command"` for bash or `"prompt"` for LLM evaluation |
| `command` | Bash command to execute |
| `prompt` | LLM prompt (for prompt-based hooks) |
| `timeout` | Timeout in seconds (default: 60) |
| `once` | Run only once per session (skills only) |

## Hook Input (stdin JSON)

All hooks receive JSON via stdin with common fields:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "EventName"
}
```

### PreToolUse Input

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run tests",
    "timeout": 120000
  },
  "tool_use_id": "toolu_01ABC123..."
}
```

**Tool-specific `tool_input` schemas:**

**Bash**:
```json
{
  "command": "string",
  "description": "string (optional)",
  "timeout": "number (optional)",
  "run_in_background": "boolean (optional)"
}
```

**Write**:
```json
{
  "file_path": "/absolute/path",
  "content": "file content"
}
```

**Edit**:
```json
{
  "file_path": "/absolute/path",
  "old_string": "text to find",
  "new_string": "replacement",
  "replace_all": "boolean (optional)"
}
```

**Read**:
```json
{
  "file_path": "/absolute/path",
  "offset": "number (optional)",
  "limit": "number (optional)"
}
```

### PostToolUse Input

Same as PreToolUse plus `tool_response`:

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path", "content": "..." },
  "tool_response": { "filePath": "/path", "success": true }
}
```

### UserPromptSubmit Input

```json
{
  "hook_event_name": "UserPromptSubmit",
  "prompt": "User's prompt text"
}
```

### Stop/SubagentStop Input

```json
{
  "hook_event_name": "Stop",
  "stop_hook_active": true
}
```

For SubagentStop, also includes:
```json
{
  "agent_id": "def456",
  "agent_transcript_path": "/path/to/subagent/transcript.jsonl"
}
```

### SessionStart Input

```json
{
  "hook_event_name": "SessionStart",
  "source": "startup | resume | clear | compact",
  "model": "claude-sonnet-4-20250514"
}
```

### Notification Input

```json
{
  "hook_event_name": "Notification",
  "message": "Notification message",
  "notification_type": "permission_prompt | idle_prompt | auth_success"
}
```

## Hook Output

### Exit Code Method (Simple)

| Code | Behavior |
|------|----------|
| `0` | Success. stdout shown in verbose mode |
| `2` | Blocking error. stderr fed to Claude |
| Other | Non-blocking error. stderr shown in verbose |

### JSON Output Method (Advanced)

Return structured JSON to stdout (exit code 0 only):

```json
{
  "continue": true,
  "stopReason": "string",
  "suppressOutput": true,
  "systemMessage": "string",
  "decision": "block | approve",
  "reason": "string",
  "hookSpecificOutput": { ... }
}
```

## Decision Control by Hook Type

### PreToolUse Decision Control

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask",
    "permissionDecisionReason": "Reason shown to user/Claude",
    "updatedInput": { "field": "new value" },
    "additionalContext": "Context for Claude"
  }
}
```

| Decision | Effect |
|----------|--------|
| `allow` | Bypasses permission, executes tool |
| `deny` | Blocks tool, shows reason to Claude |
| `ask` | Shows permission dialog to user |

### PermissionRequest Decision Control

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow | deny",
      "updatedInput": { ... },
      "message": "Denial reason",
      "interrupt": true
    }
  }
}
```

### PostToolUse Decision Control

```json
{
  "decision": "block",
  "reason": "Explanation for Claude",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Additional info"
  }
}
```

### UserPromptSubmit Decision Control

```json
{
  "decision": "block",
  "reason": "Shown to user (not in context)",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Added to Claude's context"
  }
}
```

Or simply print text to stdout (exit 0) to add context.

### Stop/SubagentStop Decision Control

```json
{
  "decision": "block",
  "reason": "Tell Claude why it must continue"
}
```

### SessionStart Context Injection

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Context for the session"
  }
}
```

Or print text to stdout.

## Persisting Environment Variables

SessionStart and Setup hooks can persist env vars using `CLAUDE_ENV_FILE`:

```bash
#!/bin/bash
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export NODE_ENV=production' >> "$CLAUDE_ENV_FILE"
  echo 'export API_KEY=your-key' >> "$CLAUDE_ENV_FILE"
fi
exit 0
```

## Prompt-Based Hooks

For `Stop` and `SubagentStop`, use LLM evaluation:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "prompt",
        "prompt": "Evaluate if Claude should stop: $ARGUMENTS. Check if all tasks are complete.",
        "timeout": 30
      }]
    }]
  }
}
```

LLM must respond with:
```json
{
  "ok": true | false,
  "reason": "Required when ok is false"
}
```

## MCP Tool Hooks

MCP tools follow pattern `mcp__<server>__<tool>`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "mcp__memory__.*",
      "hooks": [{ "type": "command", "command": "echo 'Memory op'" }]
    }]
  }
}
```

## Hooks in Skills and Agents

Define scoped hooks in frontmatter:

```yaml
---
name: secure-operations
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/security-check.sh"
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "./scripts/lint.sh"
---
```

Supported: `PreToolUse`, `PostToolUse`, `Stop`

Skills also support `once: true` to run only once per session.

## Example: Bash Command Validator

```python
#!/usr/bin/env python3
import json
import re
import sys

VALIDATION_RULES = [
    (r"\brm\s+-rf\s+/", "Dangerous: rm -rf on root"),
    (r"\bsudo\b", "sudo commands not allowed"),
]

try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Invalid JSON: {e}", file=sys.stderr)
    sys.exit(1)

tool_input = input_data.get("tool_input", {})
command = tool_input.get("command", "")

for pattern, message in VALIDATION_RULES:
    if re.search(pattern, command):
        print(message, file=sys.stderr)
        sys.exit(2)  # Block with stderr message

sys.exit(0)  # Allow
```

## Example: Auto-Approve Safe Operations

```python
#!/usr/bin/env python3
import json
import sys

input_data = json.load(sys.stdin)
tool_name = input_data.get("tool_name", "")
tool_input = input_data.get("tool_input", {})

if tool_name == "Read":
    file_path = tool_input.get("file_path", "")
    if file_path.endswith((".md", ".txt", ".json")):
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Auto-approved doc file"
            }
        }
        print(json.dumps(output))
        sys.exit(0)

sys.exit(0)  # Let normal flow continue
```

## Example: Session Context Loader

```bash
#!/bin/bash
# SessionStart hook to load project context

echo "Project: $(basename $CLAUDE_PROJECT_DIR)"
echo "Node version: $(node --version 2>/dev/null || echo 'not installed')"
echo "Git branch: $(git branch --show-current 2>/dev/null || echo 'not a git repo')"

# Persist environment
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export PROJECT_NAME=$(basename $CLAUDE_PROJECT_DIR)" >> "$CLAUDE_ENV_FILE"
fi

exit 0
```

## Execution Details

- **Timeout**: 60 seconds default, configurable per hook
- **Parallelization**: All matching hooks run in parallel
- **Deduplication**: Identical commands are deduplicated
- **Environment**: Runs in current directory with Claude Code's env

## Debugging

1. **Check registration**: `/hooks` shows configured hooks
2. **Debug mode**: `claude --debug` for execution details
3. **Verbose mode**: `ctrl+o` to see hook output
4. **Test manually**: Run commands outside Claude first

### Debug Output

```
[DEBUG] Executing hooks for PostToolUse:Write
[DEBUG] Found 1 hook commands to execute
[DEBUG] Hook command completed with status 0: <output>
```

## Security Considerations

1. **Validate inputs** - Never trust input blindly
2. **Quote variables** - Use `"$VAR"` not `$VAR`
3. **Block path traversal** - Check for `..` in paths
4. **Use absolute paths** - Use `$CLAUDE_PROJECT_DIR`
5. **Skip sensitive files** - Avoid `.env`, `.git/`, keys

Hooks modified during a session require review in `/hooks` before taking effect.

## Official Documentation

https://code.claude.com/docs/en/hooks
