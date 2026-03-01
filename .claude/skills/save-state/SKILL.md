---
name: save-state
description: Manually save current session state before context clear or as a checkpoint. Use before /clear or when you want to preserve context.
argument-hint: [optional description of current state]
---

# Save State

Manually save current session state to `.claude/state/assistant-state.md`. Use before `/clear` or as a checkpoint when working on complex tasks.

## When to Use

- Before running `/clear` to preserve context
- When switching to a different task
- As a checkpoint during long-running work
- Before potentially destructive operations
- When you want to resume later exactly where you left off

## What Gets Saved

The state file captures:
1. **Current Task**: What you're actively working on
2. **Progress**: What's been done so far
3. **Next Steps**: Immediate next actions
4. **Context**: Relevant files, decisions, blockers, active channel
5. **Notes**: Anything important to remember

**Always include the active comms channel** (from `.claude/state/channel.txt`) so you know how to reach the user after a clear/restart.

## File Format

`.claude/state/assistant-state.md`:

```markdown
# Assistant State

**Saved**: 2026-01-28 14:30:00
**Session**: abc123

## Current Task
Working on implementing the authentication feature [task:a1b]

## Progress
- [x] Set up auth middleware
- [x] Created login endpoint
- [ ] Add password validation
- [ ] Implement session management

## Next Steps
1. Add password strength validation
2. Set up bcrypt for password hashing
3. Test login flow

## Context
- Working in: src/auth/
- Key files: auth.ts, middleware.ts, routes.ts
- Using: express-session for sessions
- Decision: Using bcrypt over argon2 for compatibility

## Blockers
None currently

## Notes
User prefers email-based auth, not OAuth for this phase.
Needs to work without JavaScript for accessibility.
```

## Workflow

1. **Gather Current Context**
   - What task are you working on?
   - What have you completed?
   - What's next?
   - What files are you working with?
   - Any important decisions or context?

2. **Format State**
   - Use the template above
   - Be specific but concise
   - Include file paths for easy navigation

3. **Write State File**
   - Write to `.claude/state/assistant-state.md`
   - Overwrites previous state (it's current state, not history)

4. **Append to 24hr Log**
   - Run: `./scripts/append-state-log.sh "reason"` (use the save reason or auto-generate one)
   - The script automatically **condenses** the state: keeps key sections (Current Task, Completed, Next Steps, Context, Blockers), limits each to a few lines, drops verbose metadata and Open Todos (already in todo files)
   - Protected by three layers: **time throttle** (15 min, unless `--force`), **condensing** (~80% size reduction), **content dedup** (skips if identical to last entry, even with `--force`)
   - The 24hr log feeds the nightly consolidation cascade

5. **Confirm Save**
   - Report what was saved
   - Note any active tasks

## Arguments

If provided, `$ARGUMENTS` is used as a description of the current state:

- `/save-state` - Auto-generate state from context
- `/save-state "Pausing auth work to help with bug"` - Include custom note

## Output

```
## State Saved

**File**: .claude/state/assistant-state.md
**Time**: 2026-01-28 14:30:00

### Summary
- Current task: [a1b] Implement login flow
- Progress: 2/4 items complete
- Next: Add password validation

State will be loaded automatically on next session start.
You can safely /clear now.
```

## Integration

### With PreCompact Hook
The PreCompact hook calls this automatically before context compaction.
Manual save is for when you want to save at a specific point.

### With SessionStart Hook
SessionStart loads this file and injects context, so you resume where you left off.

### With Tasks
Reference active tasks by ID so they can be resolved on load.

## Best Practices

- Save before any `/clear`
- Save when switching major contexts
- Be specific about next steps
- Include enough context to resume without re-reading everything
- Don't save sensitive data (use Keychain for that)

## Notes

- Only one state file exists (current state)
- State history is preserved in the 24hr rolling log (summaries/24hr.md), then rotated nightly to timeline/ daily files
- PreCompact auto-saves and auto-appends, so manual save is optional
- State is loaded at session start automatically
