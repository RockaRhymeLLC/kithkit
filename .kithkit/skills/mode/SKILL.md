---
name: mode
description: View or change the assistant's autonomy mode. Controls how much confirmation is required for actions.
argument-hint: [yolo | confident | cautious | supervised]
---

# Autonomy Mode Control

View or change the assistant's autonomy mode. This controls how much confirmation the assistant asks for before taking actions.

## Usage

- `/mode` - Show current mode and description
- `/mode yolo` - Set to yolo mode (full autonomy)
- `/mode confident` - Set to confident mode (ask on destructive actions)
- `/mode cautious` - Set to cautious mode (ask on state changes)
- `/mode supervised` - Set to supervised mode (ask on everything)

## Modes

### yolo
**Full Autonomy** - Take any action without asking for permission.
- Ideal for trusted environments and automation
- No confirmation prompts
- Maximum productivity, requires trust

### confident
**Selective Confirmation** - Ask only for destructive/irreversible actions.
- Autonomous for: reads, writes, edits, searches
- Asks for: git push, file deletes, external API calls with side effects
- Good balance of speed and safety

### cautious
**State-Change Confirmation** - Ask before any operation that changes state.
- Autonomous for: reads, searches, exploration
- Asks for: writes, edits, git operations, external calls
- Safer for unfamiliar codebases

### supervised
**Maximum Oversight** - Ask for confirmation on every significant action.
- Asks for: almost everything except basic reads
- Use when learning or for critical systems
- Slowest but most controlled

## Implementation

1. **Parse Arguments**: Check if `$ARGUMENTS` contains a mode name
2. **If no arguments**: Read and display current mode from `.claude/state/autonomy.json`
3. **If mode provided**: Validate mode name and update the JSON file
4. **Report result**: Confirm the action taken

## State File

The mode is stored in `.claude/state/autonomy.json`:

```json
{
  "mode": "confident",
  "setAt": "2026-01-28T10:00:00Z",
  "setBy": "user"
}
```

## Workflow

### Viewing Mode
1. Read `.claude/state/autonomy.json`
2. Display current mode with description
3. List all available modes for reference

### Setting Mode
1. Validate mode is one of: yolo, confident, cautious, supervised
2. Update `.claude/state/autonomy.json`
3. Confirm the change
4. Note: Changes take effect on next action (no restart needed)

## Output Format

### View Mode
```
## Current Autonomy Mode

**Mode**: confident

Selective Confirmation - Ask only for destructive/irreversible actions.
- Autonomous for: reads, writes, edits, searches
- Asks for: git push, file deletes, external API calls

### Available Modes
- `yolo` - Full autonomy, no confirmations
- `confident` - Ask on destructive actions only
- `cautious` - Ask on any state change
- `supervised` - Ask on everything
```

### Set Mode
```
## Autonomy Mode Changed

**Previous**: supervised
**New**: confident

You can now perform reads, writes, and edits autonomously.
I'll ask for confirmation before destructive operations.
```

## Integration

- SessionStart hook reads autonomy.json and injects mode into context
- CLAUDE.md contains behavior instructions per mode
- Mode affects how the assistant approaches confirmation prompts

## Notes

- Mode persists across sessions (stored in state file)
- User can always override individual actions regardless of mode
- Mode changes are logged in the file's `setAt` timestamp
- Default mode if file doesn't exist: `confident`
