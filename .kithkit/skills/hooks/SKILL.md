---
name: hooks
description: Create and manage Claude Code hooks for automating workflows. Use when setting up pre/post tool hooks, notifications, or session automation.
argument-hint: [hook type or action]
---

# Claude Code Hooks

Create, configure, and manage hooks that run shell commands or LLM prompts at specific points during Claude Code sessions.

## Usage

```
/hooks                           # Interactive: guide through hook creation
/hooks PreToolUse Bash           # Create a PreToolUse hook for Bash commands
/hooks PostToolUse Write|Edit    # Create a PostToolUse hook for file changes
/hooks SessionStart              # Create a session initialization hook
```

## What This Does

1. **Identify Hook Type**: Determine when the hook should fire
2. **Configure Matcher**: Set which tools or events to match
3. **Write Command/Prompt**: Create the hook logic
4. **Add to Settings**: Update the appropriate settings file

## Hook Types

| Hook | When It Fires |
|------|---------------|
| `SessionStart` | Session begins or resumes |
| `UserPromptSubmit` | User submits a prompt |
| `PreToolUse` | Before tool execution |
| `PermissionRequest` | When permission dialog appears |
| `PostToolUse` | After tool succeeds |
| `PostToolUseFailure` | After tool fails |
| `SubagentStart` | When spawning a subagent |
| `SubagentStop` | When subagent finishes |
| `Stop` | Claude finishes responding |
| `PreCompact` | Before context compaction |
| `SessionEnd` | Session terminates |
| `Notification` | Claude Code sends notifications |
| `Setup` | `--init` or `--maintenance` flags |

## Configuration

Hooks are configured in settings files:
- `~/.claude/settings.json` - User settings (all projects)
- `.claude/settings.json` - Project settings
- `.claude/settings.local.json` - Local project settings (not committed)

### Basic Structure

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here"
          }
        ]
      }
    ]
  }
}
```

### Matchers

- **Exact match**: `"Write"` matches only Write tool
- **Regex**: `"Edit|Write"` or `"Notebook.*"`
- **All tools**: `"*"` or `""`

### Hook Types

**Command hooks** run bash commands:
```json
{
  "type": "command",
  "command": "./scripts/check.sh",
  "timeout": 30
}
```

**Prompt hooks** use LLM evaluation (for `Stop`, `SubagentStop`):
```json
{
  "type": "prompt",
  "prompt": "Evaluate if all tasks are complete: $ARGUMENTS"
}
```

## Common Tools to Hook

| Tool | Description |
|------|-------------|
| `Bash` | Shell commands |
| `Write` | File creation |
| `Edit` | File modification |
| `Read` | File reading |
| `Glob` | File pattern matching |
| `Grep` | Content search |
| `Task` | Subagent tasks |
| `WebFetch`, `WebSearch` | Web operations |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_PROJECT_DIR` | Absolute path to project root |
| `CLAUDE_ENV_FILE` | Path for persisting env vars (SessionStart/Setup only) |
| `CLAUDE_PLUGIN_ROOT` | Plugin directory path (plugin hooks only) |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success. stdout shown in verbose mode |
| `2` | Blocking error. stderr shown to Claude |
| Other | Non-blocking error. stderr shown in verbose mode |

## Common Patterns

### Auto-format on file write
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/format.sh"
      }]
    }]
  }
}
```

### Validate commands before execution
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/validate-bash.sh"
      }]
    }]
  }
}
```

### Add context at session start
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "echo 'Project uses TypeScript with Jest for testing'"
      }]
    }]
  }
}
```

### Intelligent stop evaluation
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "prompt",
        "prompt": "Check if all tasks are complete. Context: $ARGUMENTS"
      }]
    }]
  }
}
```

## Hooks in Skills and Agents

Skills and agents can define scoped hooks in frontmatter:

```yaml
---
name: secure-operations
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/security-check.sh"
---
```

Supported events: `PreToolUse`, `PostToolUse`, `Stop`

## Debugging

1. Run `/hooks` to see registered hooks
2. Use `claude --debug` for execution details
3. Press `ctrl+o` for verbose mode output
4. Test commands manually first

## References

- For detailed hook input/output schemas, decision control, and advanced patterns, see [reference.md](reference.md)
- Official documentation: https://code.claude.com/docs/en/hooks
