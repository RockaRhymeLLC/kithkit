---
name: todo
description: Manage persistent to-dos that survive across sessions. List, add, update, and complete to-dos via the daemon HTTP API.
argument-hint: [list | add "description" | note id "text" | update id | complete id | show id]
---

# To-Do Management

Manage persistent to-dos via the daemon HTTP API. To-dos survive context clears and compaction.

## Commands

Parse $ARGUMENTS to determine the action:

### List To-Dos
- `list` or `ls` or no arguments - Show all open to-dos
- `list all` - Show all to-dos including completed
- `list priority:high` - Filter by priority
- `list status:blocked` - Filter by status

### Add To-Do
- `add "To-do description"` - Add with default priority (medium)
- `add "To-do description" priority:high` - Add with specific priority
- `add "To-do description" due:2026-02-01` - Add with due date

### Show To-Do
- `show {id}` or `{id}` - Show to-do details including all actions/history

### Add Work Note
- `note {id} "Progress update text"` - Add a work note to a to-do
- Work notes track progress, decisions, blockers, and context for resuming work
- Automatically extract references from the note text:
  - **Files**: paths like `src/foo.ts`, `daemon/src/core/main.ts`
  - **Commits**: hashes like `abc1234` or `6f6f60c`
  - **PRs**: references like `PR #28` or `#123`
- Store extracted refs in the action's `files`, `commits`, `prs` arrays
- Notes are displayed prominently in the "Work Log" section of `/todo show`

### Update To-Do
- `update {id} status:in-progress` - Change status
- `update {id} priority:high` - Change priority
- `update {id} note:"Progress note"` - Add action/note to history (same as `note` command)
- `update {id} blocked:"Waiting on X"` - Mark as blocked with reason

### Complete To-Do
- `complete {id}` - Mark to-do as completed
- `done {id}` - Alias for complete

**Documentation nudge on completion**: When completing a to-do, scan its work notes for references to doc-adjacent files (`SKILL.md`, `CLAUDE.md`, `README.md`, `kithkit.config.yaml`). Also check if the to-do involved changes to skills, config, core behaviors, or daemon features. If any apply, remind yourself (or the user) to verify the relevant docs are up to date. Example: "This todo touched skills — is the CLAUDE.md skills table still accurate?"

## API Endpoints

To-dos are managed via the daemon HTTP API (default: `http://localhost:3847`):

| Action | Method | Endpoint | Body / Notes |
|--------|--------|----------|--------------|
| List todos | `GET` | `/api/todos` | Query params: `status`, `priority` |
| Create todo | `POST` | `/api/todos` | JSON body: `{ title, description, priority, due_date, tags }` |
| Get todo detail | `GET` | `/api/todos/:id` | Returns full todo object |
| Update todo | `PUT` | `/api/todos/:id` | JSON body with fields to update (title, description, priority, status, due_date, tags) |
| Get todo history | `GET` | `/api/todos/:id/actions` | Returns audit trail of all actions |
| Delete todo | `DELETE` | `/api/todos/:id` | Permanently removes todo |

Work notes and progress updates are added via `PUT /api/todos/:id` — include a `note` field in the body. The daemon records it in the `todo_actions` audit log automatically when status or priority changes.

### Example: List open todos
```bash
curl http://localhost:3847/api/todos
curl http://localhost:3847/api/todos?status=open
curl http://localhost:3847/api/todos?priority=high
```

### Example: Create a todo
```bash
curl -X POST http://localhost:3847/api/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Set up CI/CD pipeline", "priority": "high", "due_date": "2026-02-15"}'
```

### Example: Add a work note / update status
```bash
curl -X PUT http://localhost:3847/api/todos/32 \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress"}'
```

### Example: Complete a todo
```bash
curl -X PUT http://localhost:3847/api/todos/32 \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

### Example: Get todo action history
```bash
curl http://localhost:3847/api/todos/32/actions
```

## Data Format

The daemon manages file storage internally. The JSON schema for todo objects:

See `reference.md` for the full JSON schema.

## Workflow

1. **Call the API**: Use curl to hit the appropriate `/api/todos` endpoint
2. **Parse command**: Determine action from $ARGUMENTS
3. **Execute action**:
   - List: `GET /api/todos` with optional filters, display formatted
   - Add: `POST /api/todos` with title/priority/due_date, confirm
   - Update: `PUT /api/todos/:id` with changed fields
   - Note: `PUT /api/todos/:id` with status/priority change — daemon auto-logs to audit trail
   - Complete: `PUT /api/todos/:id` with `status: "completed"`
   - History: `GET /api/todos/:id/actions` to see full audit trail
4. **Report result**: Confirm what was done

## Output Format

### List Output
```
## Open To-Dos (3)

[32] HIGH - Implement login flow
     Due: 2026-02-01 | Created: 2026-01-28

[33] MEDIUM - Write documentation
     Blocked: Waiting on API spec

[34] LOW - Clean up old files
     In Progress
```

### To-Do Detail Output
```
## To-Do [32]: Implement login flow

Priority: HIGH | Status: in-progress | Due: 2026-02-01

### Description
Build the login flow with email/password authentication.

### Work Log
- 2026-01-28 14:30 - Started research on auth libraries
- 2026-01-29 10:00 - Chose passport.js, set up middleware scaffold
  Files: src/auth/middleware.ts, src/auth/passport.ts
  Commits: abc1234
- 2026-01-29 16:00 - Login endpoint working, need to add validation
  Files: src/routes/auth.ts
  Commits: def5678

### History
- 2026-01-28 10:00 - Created
- 2026-01-28 16:00 - Status: in-progress

### Next Step
Add email validation and password strength check
```

When displaying a to-do with `/todo show`:
- **Work Log** shows only `note` type actions (the actual progress)
- **History** shows status changes, priority changes, created/completed events
- **Files/Commits/PRs** are shown indented under the note they belong to
- This separation makes it easy to quickly see what work was done vs. bookkeeping

## Bob Check (Devil's Advocate)

When picking up a **non-trivial to-do**, spawn a quick Bob (devil's advocate) sub-agent before diving into the work. This is lightweight — not a full `/review`, just a sanity check on your approach.

### When to Trigger

**Do the check for:**
- To-dos that involve design decisions or architecture choices
- Multi-step implementation work (anything that would take more than a few minutes)
- New features, integrations, or capability additions
- Self-improvement work (skills, workflows, core behaviors)

**Skip the check for:**
- Simple, mechanical tasks ("reply to email", "check calendar", "clean up temp files")
- Research/exploration tasks ("look into X", "find out about Y")
- Tasks where someone already reviewed the approach (post-`/review` or post-peer-review)

### How It Works

Before you start working on the to-do, briefly outline your planned approach (2-3 sentences), then spawn a Task sub-agent:

```
Use the Task tool with subagent_type="general-purpose":
- Give it your planned approach and the to-do description
- Ask it to challenge: Is this overcomplicated? Is there a simpler way? What could go wrong?
- Ask it to flag documentation impact: Will this change affect CLAUDE.md, any SKILL.md, README.md, or kithkit.config.yaml? If so, which ones?
- Ask for a GO / PAUSE verdict and any specific concerns
- Keep it fast — this should take seconds, not minutes
```

If the sub-agent says PAUSE with good reasons, reconsider your approach before proceeding. If it says GO, carry on with confidence.

## Integration

- To-dos can be referenced from calendar.md via `[todo:id]` syntax
- SessionStart hook loads high-priority to-dos into context
- PreCompact hook saves active to-do state
- Bob (devil's advocate sub-agent) runs automatically for non-trivial work

## Notes

- IDs are auto-incrementing integers managed by the daemon
- Legacy alphanumeric IDs (a1b, z6f, etc.) are still recognized by the API
- Completed to-dos are kept for history (can be archived manually)
- The `actions` array provides a full audit trail

## References

- [reference.md](reference.md) — Complete JSON schema and examples for to-do structure
