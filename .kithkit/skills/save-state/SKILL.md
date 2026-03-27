---
name: save-state
description: Manually save current session state before restart or as a checkpoint. Use before /restart or when you want to preserve context.
argument-hint: [optional description of current state]
---

# Save State

Save session state and update todo notes before restart or context loss. This skill has three jobs:

1. **Update todo notes** — so project history captures decisions and progress
2. **Write assistant-state.md** — so the next session can resume
3. **Append to 24hr log** — so the timeline captures what happened

All three matter. Todo notes are the persistent project record. The state file is for session continuity. The 24hr log feeds the nightly timeline.

## When to Use

**Usually use `/restart` instead of `/save-state` directly.** `/restart` calls `/save-state` as its first step, then restarts the session.

This skill is called by:
- The `/restart` skill as step 1
- The context watchdog before a scheduled restart
- The PreCompact hook before context compaction
- Direct invocation when you need a checkpoint without restarting

## Workflow

### Step 1: Update Todo Notes

Do this FIRST, while context is freshest.

For each todo you touched this session, add a work note via the daemon API (`PUT /api/todos/:id`) capturing:

| What to capture | Example |
|----------------|---------|
| **Decisions the human made** | "User chose Option 3 — deploy web app on Azure, native later" |
| **Direction changes** | "User shelved LLC registration, focus on bounties first" |
| **Work completed** | "Built Open-Meteo weather integration, committed abc1234" |
| **Files changed** | "Modified daemon/src/automation/tasks/morning-briefing.ts" |
| **Blockers discovered** | "Need user's GitHub OAuth to create Algora account" |
| **What's next for this todo** | "Next: deploy on Azure" |

**The human's decisions are the most important thing to capture.** When the human gives direction, sets priorities, picks options, or changes course — that's the stuff that gets lost between sessions. Your own work progress is easier to reconstruct from git history. The human's intent is not.

How to identify which todos were touched:
- Did you work on, discuss, or make progress on any todo?
- Did the human give direction, make decisions, or change priorities on any todo?
- Did you create, complete, or change status on any todo?

For each one, call `PUT /api/todos/:id` with the note as a description update. Include the key details — be specific, not vague.

**Skip** todos you only glanced at or listed but didn't actually work on or discuss.

### Step 2: Write State File

Write to `.kithkit/state/assistant-state.md`:

```markdown
# Assistant State

**Saved**: YYYY-MM-DD HH:MM:SS
**Reason**: [why you're saving — context low, switching tasks, etc.]

## Current Task
What you're actively working on (be specific, reference todo IDs)

## What We Did This Session
- Key accomplishments, commits, files changed
- Decisions made (with rationale)
- Conversations had (summarize, don't reproduce)

## Next Steps
1. Immediate next action
2. Second priority
3. etc.

## Context
- Key files being worked on
- Important state (what's deployed, what's broken, etc.)
- Who you were talking to (channel, topic)

## Blockers
What's waiting on the human or external input
```

**Do NOT include a "Channel:" line** — `channel.txt` is the single source of truth for channel state.

### Step 3: Append to 24hr Log

Append a brief entry directly to `.kithkit/state/memory/summaries/24hr.md`. The format is a timestamped markdown section:

```markdown
## YYYY-MM-DD HH:MM — [reason]

- [1-3 bullet points summarizing what happened this session]
- Current task: [todo ID and description]
- Next: [immediate next action]
```

Write this with the Write or Edit tool — no daemon API call needed. The nightly memory-consolidation task (5am) will rotate this to the appropriate `timeline/YYYY-MM-DD.md` file automatically.

### Step 4: Confirm

Report what was saved. The output MUST include which todos were updated:

```
## State Saved

**File**: .kithkit/state/assistant-state.md
**Time**: 2026-01-28 14:30:00

### Todos Updated
- [032] Added note: User chose bcrypt, login endpoint working
- [045] Added note: Shelved per user's request

### Session Summary
- Current task: [032] Implement login flow
- Progress: 2/4 items complete
- Next: Add password validation

State will be loaded automatically on next session start.
```

If no todos were updated, explicitly state: **"No todos touched this session."** This forces a conscious acknowledgment rather than silent omission.

## Arguments

If provided, `$ARGUMENTS` is used as a description of the current state:

- `/save-state` — Auto-generate state from context
- `/save-state "Pausing auth work to help with bug"` — Include custom note

## Integration

### With PreCompact Hook
The PreCompact hook fires before context compaction. It backs up assistant-state.md and prompts you to save. Follow this full workflow when that prompt fires — don't skip the todo updates under time pressure.

### With Context Watchdog
The watchdog sends escalating messages at 50%/65%/80% context usage. When it says "/save-state", it means this full workflow — including todo updates.

### With SessionStart Hook
SessionStart loads assistant-state.md and injects context, so you resume where you left off. Todo notes from step 1 ensure the project record is accurate even if assistant-state gets stale.

### Preservation Chain
assistant-state.md → backed up by pre-compact hook (last 5 copies) → appended to 24hr.md (direct file write) → rotated to timeline/ daily files by memory-consolidation. Nothing is lost.

## Best Practices

- **Todo notes first** — do them while context is fresh, before writing the state file
- Save before any `/restart`
- Save when switching major contexts
- Be specific about next steps — future you will thank present you. **Next Steps are treated as a priority queue on resume** — the next session will work through them in order, so put the most important/urgent item first
- Don't save sensitive data (use Keychain for that)
- When in doubt about whether a todo was "touched" — if the human talked about it, it was touched
