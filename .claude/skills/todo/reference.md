# To-Do File Reference

Complete JSON schema and examples for to-do objects returned by the daemon API.

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

## Priority Values

| Priority | Description |
|----------|-------------|
| `critical` | Must be done immediately |
| `high` | Important, do soon |
| `medium` | Normal priority (default) |
| `low` | Nice to have |

## Status Values

| Status | Description |
|--------|-------------|
| `open` | Not yet started |
| `in-progress` | Actively being worked on |
| `blocked` | Waiting on something |
| `completed` | Done |

## ID Generation

IDs are auto-incrementing integers managed by the daemon. The daemon assigns the next available ID when `POST /api/todos` is called. IDs are zero-padded to 3 digits in display contexts (e.g., "032"), but the JSON `id` field stores the plain integer string (e.g., "32").

**Legacy IDs**: Older to-dos may use 3-character alphanumeric IDs (e.g., "a1b"). These remain valid for all API operations.

## API Response Examples

### GET /api/todos (list)

```json
[
  {
    "id": "32",
    "title": "Implement login flow",
    "priority": "high",
    "status": "in-progress",
    "due": "2026-02-01",
    "created": "2026-01-28T10:00:00Z",
    "blockedBy": null,
    "nextStep": "Add email validation"
  },
  {
    "id": "33",
    "title": "Write documentation",
    "priority": "medium",
    "status": "blocked",
    "blockedBy": "Waiting on API spec",
    "created": "2026-01-29T09:00:00Z"
  }
]
```

### POST /api/todos (create)

Request body:
```json
{
  "title": "Set up CI/CD pipeline",
  "priority": "high",
  "due": "2026-02-15",
  "tags": ["devops"]
}
```

Response:
```json
{
  "id": "34",
  "title": "Set up CI/CD pipeline",
  "description": null,
  "priority": "high",
  "status": "open",
  "created": "2026-01-28T12:00:00Z",
  "due": "2026-02-15",
  "nextStep": null,
  "blockedBy": null,
  "tags": ["devops"],
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

### GET /api/todos/:id/actions (get audit trail)

Returns the full action history for a todo. Each action records status changes, priority changes, and creation events.

Response:
```json
{
  "data": [
    {
      "id": 1,
      "todo_id": 34,
      "action": "created",
      "old_value": null,
      "new_value": null,
      "note": "Created with title: Set up CI/CD pipeline",
      "created_at": "2026-01-28T12:00:00Z"
    },
    {
      "id": 2,
      "todo_id": 34,
      "action": "status_change",
      "old_value": "pending",
      "new_value": "in_progress",
      "note": null,
      "created_at": "2026-01-29T10:00:00Z"
    }
  ],
  "timestamp": "2026-01-29T10:01:00Z"
}
