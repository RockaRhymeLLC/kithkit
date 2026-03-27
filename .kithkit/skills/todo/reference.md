# To-Do File Reference

Complete JSON schema and examples for to-do files.

## JSON Schema

```json
{
  "id": "032",
  "title": "Implement login flow",
  "description": "Build the login flow with email/password authentication.\n\nRequirements:\n- Email validation\n- Password strength check\n- Remember me option",
  "priority": "high",
  "status": "open",
  "created": "2026-01-28T10:00:00Z",
  "due": "2026-02-01",
  "nextStep": "Set up authentication middleware",
  "blockedBy": null,
  "tags": ["auth", "frontend"],
  "specRef": "specs/20260128-auth-system.spec.md",
  "actions": [
    {
      "timestamp": "2026-01-28T10:00:00Z",
      "type": "created",
      "note": null
    },
    {
      "timestamp": "2026-01-28T14:30:00Z",
      "type": "note",
      "note": "Started research on auth libraries"
    },
    {
      "timestamp": "2026-01-28T16:00:00Z",
      "type": "status_change",
      "note": "Changed to in-progress"
    }
  ]
}
```

## Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Auto-incrementing integer, zero-padded to 3 digits (e.g., "032"). Legacy alphanumeric IDs also accepted. |
| `title` | string | Yes | Short to-do title (max 80 chars) |
| `description` | string | No | Full description, supports markdown |
| `priority` | enum | Yes | `critical`, `high`, `medium`, `low` |
| `status` | enum | Yes | `open`, `in-progress`, `blocked`, `completed` |
| `created` | ISO datetime | Yes | When to-do was created |
| `due` | ISO date | No | Due date (YYYY-MM-DD) |
| `nextStep` | string | No | Immediate next action |
| `blockedBy` | string | No | Reason for blocked status |
| `tags` | string[] | No | Categorization tags |
| `specRef` | string | No | Path to related spec file |
| `actions` | Action[] | Yes | Audit trail of all changes |

## Action Types

| Type | When Used |
|------|-----------|
| `created` | To-do first created |
| `note` | Work note / progress update added |
| `status_change` | Status field changed |
| `priority_change` | Priority field changed |
| `completed` | To-do marked complete |
| `reopened` | Completed to-do reopened |

## Action Schema

All actions have these base fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timestamp` | ISO datetime | Yes | When the action occurred |
| `type` | string | Yes | One of the action types above |
| `note` | string | No | Free-form text (progress description, reason, etc.) |

Actions of type `note` may also include reference fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `files` | string[] | No | File paths referenced in this note (e.g., `["src/auth/middleware.ts"]`) |
| `commits` | string[] | No | Commit hashes (e.g., `["6f6f60c", "cec38b0"]`) |
| `prs` | string[] | No | PR references (e.g., `["#28", "upstream#15"]`) |

These reference fields are auto-extracted from note text when using `/todo note`. They make it easy to find related code changes when resuming work.

### Example: Note with references

```json
{
  "timestamp": "2026-02-06T07:15:00-05:00",
  "type": "note",
  "note": "Added isIdle() to session-bridge.ts. Wired into todo-reminder.ts as gate. Committed as 6a0b1bf.",
  "files": ["daemon/src/core/session-bridge.ts", "daemon/src/automation/tasks/todo-reminder.ts"],
  "commits": ["6a0b1bf"]
}
```

## Priority Mapping

For filename sorting:
- `critical` → `1`
- `high` → `2`
- `medium` → `3`
- `low` → `4`

## Status Mapping

For filename:
- `open` → `open`
- `in-progress` → `in-progress`
- `blocked` → `blocked`
- `completed` → `completed`

## ID Generation

IDs are auto-incrementing integers managed by a counter file.

1. Read `.claude/state/todos/.counter` to get the next ID number
2. Use that number as the new to-do's ID (zero-padded to 3 digits in filenames, plain integer in JSON)
3. Write the incremented value back to `.counter`

```
# Example: .counter contains "32"
# New to-do gets id: "32"
# Filename uses: 032
# .counter updated to: "33"
```

**Legacy IDs**: Older to-dos may use 3-character alphanumeric IDs (e.g., "a1b"). These remain valid for all operations (show, update, complete). The counter only applies to newly created to-dos.

## Slug Generation

From the title:
1. Lowercase the title
2. Replace spaces and special chars with hyphens
3. Remove consecutive hyphens
4. Truncate to 30 characters
5. Remove trailing hyphens

```javascript
const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/-+/g, '-')
  .substring(0, 30)
  .replace(/-$/, '');
```

## Filename Examples

```
1-critical-open-032-fix-production-outage.json
2-high-in-progress-033-implement-login-flow.json
3-medium-blocked-034-write-documentation.json
4-low-completed-035-clean-up-old-files.json
```

Legacy format (still valid):
```
2-high-completed-a1b-implement-login-flow.json
```

## Example: Creating a To-Do

Input: `/todo add "Set up CI/CD pipeline" priority:high due:2026-02-15`

Generated file: `2-high-open-032-set-up-ci-cd-pipeline.json`

```json
{
  "id": "32",
  "title": "Set up CI/CD pipeline",
  "description": null,
  "priority": "high",
  "status": "open",
  "created": "2026-01-28T12:00:00Z",
  "due": "2026-02-15",
  "nextStep": null,
  "blockedBy": null,
  "tags": [],
  "specRef": null,
  "actions": [
    {
      "timestamp": "2026-01-28T12:00:00Z",
      "type": "created",
      "note": null
    }
  ]
}
```

## Example: Completing a To-Do

When completing to-do `32`:

1. Load current file
2. Update status to `completed`
3. Add completion action
4. Rename file from `2-high-open-032-...` to `2-high-completed-032-...`

Updated JSON:
```json
{
  "status": "completed",
  "actions": [
    // ... previous actions
    {
      "timestamp": "2026-01-30T15:00:00Z",
      "type": "completed",
      "note": "Pipeline deployed and tested"
    }
  ]
}
```

## Listing Algorithm

To list to-dos in priority order:

1. Glob `.claude/state/todos/*.json`
2. Filenames naturally sort by priority (1 before 2, etc.)
3. Filter by status if requested
4. Parse JSON for display details

The filename convention means `ls` output is already priority-sorted.
