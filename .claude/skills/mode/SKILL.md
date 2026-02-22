---
name: mode
description: Views or changes the assistant's autonomy mode (yolo, confident, cautious, supervised). Use when adjusting how much freedom or confirmation the assistant has, or checking the current mode.
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
2. **If no arguments**: Read and display current mode via `GET /api/config/autonomy`
3. **If mode provided**: Validate mode name and update via `PUT /api/config/autonomy`
4. **Report result**: Confirm the action taken

## API Endpoints

Autonomy mode is managed via the daemon HTTP API (default: `http://localhost:3847`):

| Action | Method | Endpoint | Body / Notes |
|--------|--------|----------|--------------|
| Get current mode | `GET` | `/api/config/autonomy` | Returns `{ mode, setAt, setBy }` |
| Set mode | `PUT` | `/api/config/autonomy` | JSON body: `{ mode }` |

### Example: Get current mode
```bash
curl http://localhost:3847/api/config/autonomy
```

### Example: Set mode
```bash
curl -X PUT http://localhost:3847/api/config/autonomy \
  -H "Content-Type: application/json" \
  -d '{"mode": "confident"}'
```

## State Format

The API returns/accepts:

```json
{
  "mode": "confident",
  "setAt": "2026-01-28T10:00:00Z",
  "setBy": "user"
}
```

## Workflow

### Viewing Mode
1. Call `GET /api/config/autonomy`
2. Display current mode with description
3. List all available modes for reference

### Setting Mode
1. Validate mode is one of: yolo, confident, cautious, supervised
2. Call `PUT /api/config/autonomy` with `{ mode }`
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

- SessionStart hook reads autonomy mode and injects it into context
- CLAUDE.md contains behavior instructions per mode
- Mode affects how the assistant approaches confirmation prompts

## Notes

- Mode persists across sessions (stored via daemon API)
- User can always override individual actions regardless of mode
- Mode changes are logged with `setAt` timestamp
- Default mode if not configured: `confident`
