# To-Do API Reference

Complete schema and examples for the daemon's todo API.

## Database Schema

Todos are stored in SQLite (`todos` table). The daemon manages all storage — agents interact only via the HTTP API.

### `todos` Table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | INTEGER | autoincrement | Primary key |
| `title` | TEXT | required | Short to-do title |
| `description` | TEXT | null | Full description, supports markdown |
| `priority` | TEXT | `'medium'` | `critical`, `high`, `medium`, `low` |
| `status` | TEXT | `'pending'` | `pending`, `in_progress`, `completed`, `cancelled` |
| `due_date` | TEXT | null | Due date (ISO date string, e.g., `2026-02-15`) |
| `tags` | JSON | `'[]'` | JSON array of string tags |
| `created_at` | TEXT | `datetime('now')` | Creation timestamp |
| `updated_at` | TEXT | `datetime('now')` | Last update timestamp |

### `todo_actions` Table (Audit Trail)

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | INTEGER | autoincrement | Primary key |
| `todo_id` | INTEGER | required | Foreign key to `todos.id` (CASCADE delete) |
| `action` | TEXT | required | Action type (see below) |
| `old_value` | TEXT | null | Previous value (for changes) |
| `new_value` | TEXT | null | New value (for changes) |
| `note` | TEXT | null | Free-form note text |
| `created_at` | TEXT | `datetime('now')` | Action timestamp |

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
| `pending` | Not yet started |
| `in_progress` | Actively being worked on |
| `completed` | Done |
| `cancelled` | No longer needed |

## Action Types

| Type | When Used |
|------|-----------|
| `created` | Todo first created |
| `status_change` | Status field changed (old_value/new_value populated) |
| `priority_change` | Priority field changed (old_value/new_value populated) |

## API Response Examples

### GET /api/todos (list)

Response:
```json
{
  "data": [
    {
      "id": 32,
      "title": "Implement login flow",
      "description": null,
      "priority": "high",
      "status": "in_progress",
      "due_date": "2026-02-01",
      "tags": "[]",
      "created_at": "2026-01-28T10:00:00Z",
      "updated_at": "2026-01-29T10:00:00Z"
    },
    {
      "id": 33,
      "title": "Write documentation",
      "description": null,
      "priority": "medium",
      "status": "pending",
      "due_date": null,
      "tags": "[\"docs\"]",
      "created_at": "2026-01-29T09:00:00Z",
      "updated_at": "2026-01-29T09:00:00Z"
    }
  ],
  "timestamp": "2026-01-29T12:00:00Z"
}
```

### POST /api/todos (create)

Request body:
```json
{
  "title": "Set up CI/CD pipeline",
  "priority": "high",
  "due_date": "2026-02-15",
  "tags": ["devops"]
}
```

Response (201):
```json
{
  "id": 34,
  "title": "Set up CI/CD pipeline",
  "description": null,
  "priority": "high",
  "status": "pending",
  "due_date": "2026-02-15",
  "tags": "[\"devops\"]",
  "created_at": "2026-01-28T12:00:00Z",
  "updated_at": "2026-01-28T12:00:00Z",
  "timestamp": "2026-01-28T12:00:00Z"
}
```

### PUT /api/todos/:id (update)

Request body (partial update — only include fields to change):
```json
{
  "status": "in_progress"
}
```

Response (200): Full updated todo object.

**Validation rules:**
- `priority` must be one of: `critical`, `high`, `medium`, `low`
- `status` must be one of: `pending`, `in_progress`, `completed`, `cancelled`
- Invalid values return 400 with error message

### GET /api/todos/:id/actions (audit trail)

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
```

### DELETE /api/todos/:id

Response: 204 No Content (on success), 404 if not found.

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Invalid JSON body, missing required field, or invalid enum value |
| 404 | Todo not found |
| 413 | Request body too large (>1MB) |
