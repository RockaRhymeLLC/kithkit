# Todos & Calendar API Reference

CRUD operations for todos (with audit trail) and calendar events.

## Todos

### GET /api/todos

List all todos, ordered by `created_at DESC`.

```bash
curl http://localhost:3847/api/todos
```

**Response (200):**
```json
{
  "data": [
    {
      "id": 1,
      "title": "Write documentation",
      "description": null,
      "priority": "medium",
      "status": "pending",
      "due_date": null,
      "tags": "[]",
      "created_at": "2026-02-22T00:00:00.000Z",
      "updated_at": "2026-02-22T00:00:00.000Z"
    }
  ],
  "timestamp": "..."
}
```

**Note:** `tags` is stored as a JSON string (e.g., `"[\"docs\",\"v1\"]"`). Parse client-side.

---

### POST /api/todos

Create a todo.

```bash
curl -X POST http://localhost:3847/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"title": "Review PR", "priority": "high", "due_date": "2026-03-01"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Short todo title |
| `description` | string | no | Full description (supports markdown) |
| `priority` | string | no | `low`, `medium` (default), `high`, `critical` |
| `status` | string | no | `pending` (default), `in_progress`, `blocked`, `completed`, `cancelled` |
| `due_date` | string | no | ISO date string (e.g., `2026-02-15`) |
| `tags` | string[] | no | Array of tags (JSON-serialized on storage) |

**Responses:**

| Status | Body |
|--------|------|
| 201 | Full todo object |
| 400 | Missing title, invalid priority, or invalid status |

**Gotchas:**
- A `created` action is automatically logged to the audit trail
- Tags must be an array — they're serialized to JSON for storage

---

### GET /api/todos/:id

Get a single todo.

```bash
curl http://localhost:3847/api/todos/21
```

| Status | Response |
|--------|----------|
| 200 | Todo object |
| 404 | `{ "error": "Not found" }` |

---

### PUT /api/todos/:id

Update a todo. All fields optional. Status and priority changes are auto-logged to the audit trail.

```bash
# Update status
curl -X PUT http://localhost:3847/api/todos/21 \
  -H 'Content-Type: application/json' \
  -d '{"status": "completed"}'

# Update multiple fields
curl -X PUT http://localhost:3847/api/todos/21 \
  -H 'Content-Type: application/json' \
  -d '{"priority": "critical", "description": "Urgent: deploy by EOD"}'
```

**Request body:** Same fields as POST (all optional). Only include fields to change.

| Status | Response |
|--------|----------|
| 200 | Updated todo object |
| 400 | Invalid priority or status |
| 404 | Not found |

**Auto-logged actions:**
- Status changes → `status_change` action with old/new values
- Priority changes → `priority_change` action with old/new values

---

### DELETE /api/todos/:id

Hard delete a todo and its audit trail.

```bash
curl -X DELETE http://localhost:3847/api/todos/21
```

| Status | Response |
|--------|----------|
| 204 | No body |
| 404 | `{ "error": "Not found" }` |

---

### GET /api/todos/:id/actions

Get the audit trail for a todo — all status changes, priority changes, and creation events.

```bash
curl http://localhost:3847/api/todos/21/actions
```

**Response (200):**
```json
{
  "data": [
    {
      "id": 1,
      "todo_id": 21,
      "action": "created",
      "old_value": null,
      "new_value": null,
      "note": "Created with title: Build daemon-api skill",
      "created_at": "2026-02-22T10:00:00.000Z"
    },
    {
      "id": 2,
      "todo_id": 21,
      "action": "status_change",
      "old_value": "pending",
      "new_value": "in_progress",
      "note": null,
      "created_at": "2026-02-22T10:30:00.000Z"
    }
  ],
  "timestamp": "..."
}
```

**Action types:** `created`, `status_change`, `priority_change`

---

### Valid Enums

**Priority:** `low`, `medium`, `high`, `critical`

**Status:** `pending`, `in_progress`, `blocked`, `completed`, `cancelled`

---

## Calendar

### GET /api/calendar

List calendar events. Optionally filter by date.

```bash
# All events
curl http://localhost:3847/api/calendar

# Events on a specific date
curl "http://localhost:3847/api/calendar?date=2026-02-22"
```

| Query Param | Type | Description |
|-------------|------|-------------|
| `date` | string | ISO date (`YYYY-MM-DD`) — filter to events on this date |

**Response (200):**
```json
{
  "data": [
    {
      "id": 1,
      "title": "Team standup",
      "description": null,
      "start_time": "2026-02-22T09:00:00.000Z",
      "end_time": "2026-02-22T09:30:00.000Z",
      "all_day": 0,
      "source": "manual",
      "todo_ref": null,
      "created_at": "2026-02-22T00:00:00.000Z"
    }
  ],
  "timestamp": "..."
}
```

---

### POST /api/calendar

Create a calendar event.

```bash
curl -X POST http://localhost:3847/api/calendar \
  -H 'Content-Type: application/json' \
  -d '{"title": "Project review", "start_time": "2026-02-25T14:00:00Z"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Event title |
| `start_time` | string | yes | ISO 8601 datetime |
| `description` | string | no | Event description |
| `end_time` | string | no | ISO 8601 datetime |
| `all_day` | boolean | no | All-day event (stored as 0/1) |
| `source` | string | no | Origin label |
| `todo_ref` | number | no | Foreign key to a todo ID |

| Status | Response |
|--------|----------|
| 201 | Full event object |
| 400 | Missing title or start_time |

---

### GET /api/calendar/:id

Get a single calendar event.

| Status | Response |
|--------|----------|
| 200 | Event object |
| 404 | `{ "error": "Not found" }` |

---

### PUT /api/calendar/:id

Update a calendar event. All fields optional.

```bash
curl -X PUT http://localhost:3847/api/calendar/1 \
  -H 'Content-Type: application/json' \
  -d '{"end_time": "2026-02-25T15:00:00Z"}'
```

| Status | Response |
|--------|----------|
| 200 | Updated event object |
| 404 | Not found |

---

### DELETE /api/calendar/:id

Hard delete a calendar event.

| Status | Response |
|--------|----------|
| 204 | No body |
| 404 | `{ "error": "Not found" }` |
