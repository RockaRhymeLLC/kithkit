# Kithkit Daemon API Reference

The daemon runs a local HTTP server on `127.0.0.1:<port>` (default 3847). It binds to localhost only — no remote access. All JSON responses include a `timestamp` field (ISO 8601). Invalid JSON bodies return `400 { "error": "Invalid JSON" }`.

## Table of Contents

- [Common Pitfalls](#common-pitfalls)
- [Health & Status](#health--status)
- [Agents](#agents)
- [Todos](#todos)
- [Calendar](#calendar)
- [Messages](#messages)
- [Channel Delivery](#channel-delivery)
- [Memory](#memory)
- [Config & State](#config--state)
- [Scheduler / Tasks](#scheduler--tasks)
- [Orchestrator Tasks](#orchestrator-tasks)
- [Usage & Metrics](#usage--metrics)
- [Orchestrator](#orchestrator)
- [Timers](#timers)
- [A2A Messaging](#a2a-messaging)
- [Error Responses](#error-responses)

---

## Common Pitfalls

This section documents the most common errors agents hit when calling the daemon API, and how to fix them.

### zsh glob expansion on URLs with `?`

**Problem**: zsh treats `?` in unquoted URLs as a glob wildcard, expanding it before curl sees it.

```bash
# WRONG — zsh expands the ? and curl gets a mangled URL or "no matches found" error
curl http://localhost:3847/api/messages?agent=comms
curl http://localhost:3847/api/orchestrator/tasks?status=pending
```

**Fix**: Always quote URLs that contain query parameters.

```bash
# Correct — double-quoted URL passes through unmodified
curl "http://localhost:3847/api/messages?agent=comms"
curl "http://localhost:3847/api/orchestrator/tasks?status=pending"
```

---

### JSON strings with special characters — use heredoc or Python

**Problem**: Shell interpolation and escaping make it error-prone to embed special characters (quotes, newlines, backslashes) in `-d '...'` strings.

```bash
# WRONG — the apostrophe in "don't" breaks the single-quoted string
curl -X POST http://localhost:3847/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"from":"comms","to":"orchestrator","body":"don't forget"}'
```

**Fix option 1 — heredoc**: The cleanest approach for multi-line or special-char JSON.

```bash
curl -X POST http://localhost:3847/api/messages \
  -H 'Content-Type: application/json' \
  -d "$(cat <<'EOF'
{"from":"comms","to":"orchestrator","body":"don't forget","type":"task"}
EOF
)"
```

**Fix option 2 — Python json.dumps**: Use Python to build the JSON safely.

```bash
curl -X POST http://localhost:3847/api/messages \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json; print(json.dumps({'from':'comms','to':'orchestrator','body':\"don't forget\",'type':'task'}))")"
```

**Fix option 3 — write to a temp file**:

```bash
cat > /tmp/msg.json <<'EOF'
{"from":"comms","to":"orchestrator","body":"don't forget","type":"task"}
EOF
curl -X POST http://localhost:3847/api/messages \
  -H 'Content-Type: application/json' \
  -d @/tmp/msg.json
rm /tmp/msg.json
```

---

### Field name mismatches — `body` not `text`, `agent` required

**Problem**: The messages API uses `body` for the message content, not `message` or `text`. The `agent` query parameter is required on `GET /api/messages`.

```bash
# WRONG — 'text' is silently ignored; 'body' is required
curl -X POST http://localhost:3847/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"from":"comms","to":"orchestrator","text":"hello"}'
# → 400 {"error":"body is required"}

# WRONG — missing required ?agent= parameter
curl http://localhost:3847/api/messages
# → 400 {"error":"agent query parameter is required"}
```

**Fix**:

```bash
# Correct POST — use 'body'
curl -X POST http://localhost:3847/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"from":"comms","to":"orchestrator","body":"hello","type":"task"}'

# Correct GET — include ?agent=
curl "http://localhost:3847/api/messages?agent=comms"
```

---

### Task activity — `message` not `event_type`

**Problem**: `POST /api/orchestrator/tasks/:id/activity` requires a `message` field. The `event_type` + `details` shape (from `POST /api/agents/:id/activity`) does not apply here.

```bash
# WRONG — uses agent activity field names; task activity requires 'message'
curl -X POST "http://localhost:3847/api/orchestrator/tasks/$TASK_ID/activity" \
  -H 'Content-Type: application/json' \
  -d '{"event_type":"progress","details":"Step 1 complete"}'
# → 400 {"error":"message is required"}
```

**Fix**:

```bash
# Correct — use 'message' (and optionally 'type', 'agent', 'stage')
curl -X POST "http://localhost:3847/api/orchestrator/tasks/$TASK_ID/activity" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Step 1 complete","type":"progress","agent":"orchestrator","stage":"research"}'
```

Worker-assignment also uses `worker_id`, not `jobId`:

```bash
# WRONG
-d '{"jobId":"abc","profile":"coding","prompt":"Fix auth"}'

# Correct
-d '{"worker_id":"abc","role":"coding"}'
```

---

### Orchestrator task status transitions are enforced

**Problem**: The orchestrator task state machine only allows specific transitions. Attempting an invalid transition returns 409.

| From | Allowed next statuses |
|------|-----------------------|
| `pending` | `assigned`, `failed` |
| `assigned` | `in_progress`, `failed`, `pending` |
| `in_progress` | `completed`, `failed` |
| `completed` | (terminal — no updates allowed) |
| `failed` | (terminal — no updates allowed) |

```bash
# Will fail if task is already 'completed' or 'failed'
curl -X PUT "http://localhost:3847/api/orchestrator/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}'
# → 409 {"error":"Cannot update completed task"}
```

Additional rule: `pending` tasks must have `null` assignee; `assigned` tasks must have a non-null assignee.

---

### Channel delivery — `channels` array, not `channel` string

**Problem**: The `/api/send` endpoint accepts both `channels` (array) and `channel` (singular string), but requesting unknown channels returns 400 rather than silently broadcasting.

```bash
# WRONG — typo in channel name returns 400
curl -X POST http://localhost:3847/api/send \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello","channels":["telegam"]}'
# → 400 {"error":"Unknown channel(s): telegam. Registered: telegram"}

# Correct — omit channels to broadcast to all configured adapters
curl -X POST http://localhost:3847/api/send \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello"}'
```

---

### Memory search — at least one filter required for keyword mode

**Problem**: `POST /api/memory/search` with `mode: "keyword"` (the default) requires at least one of: `query`, `tags`, `category`, `type`, `date_from`, `date_to`. An empty body returns 400.

```bash
# WRONG — no filters
curl -X POST http://localhost:3847/api/memory/search \
  -H 'Content-Type: application/json' \
  -d '{}'
# → 400 {"error":"query or at least one filter required"}
```

Vector and hybrid modes require a `query` string specifically.

---

### Request body too large (413)

**Problem**: The daemon enforces a body size limit. Very large prompts or task descriptions can hit it.

```bash
# → 413 {"error":"Request body too large"}
```

**Fix**: Split the content across multiple requests, or use a session directory file reference instead of embedding large content directly in the request body.

---

## Health & Status

### GET /health

Returns daemon health and extension status.

```bash
curl http://localhost:3847/health
```

```json
// Response 200
{
  "status": "ok",
  "uptime": 3742,
  "version": "0.1.0",
  "timestamp": "2026-02-22T09:00:00.000Z",
  "degraded": false,
  "extension": "my-agent",
  "extensionRoutes": ["/my-ext/status", "/my-ext/*"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` | Always "ok" on this endpoint |
| `uptime` | number | Daemon uptime in seconds |
| `version` | string | Daemon version |
| `degraded` | boolean | `true` if extension init failed |
| `extension` | string \| null | Registered extension name, or `null` |
| `extensionRoutes` | string[] | Routes registered by the extension |

---

### GET /health/extended

Run all health checks (daemon, database, and extension-registered checks). Accepts `Accept: text/plain` for a human-readable format.

```bash
curl http://localhost:3847/health/extended
curl -H 'Accept: text/plain' http://localhost:3847/health/extended
```

```json
// Response 200 (JSON)
{
  "status": "ok",
  "uptime": 3742,
  "version": "0.1.0",
  "timestamp": "2026-02-22T09:00:00.000Z",
  "checks": {
    "daemon": {
      "ok": true,
      "message": "Daemon running",
      "details": { "uptime": 3742, "pid": 12345, "memoryMB": 48 }
    },
    "database": {
      "ok": true,
      "message": "Database OK (12 tables)",
      "details": { "tables": 12 }
    }
  }
}
```

Overall `status` is `"ok"` only if all checks pass; otherwise `"degraded"`.

---

### GET /status

Quick status check.

```bash
curl http://localhost:3847/status
```

```json
// Response 200
{
  "daemon": "running",
  "agent": "Atlas",
  "uptime": 3742.5,
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

---

### GET /status/extended

Aggregated operational status — daemon process info, DB stats, recent scheduler results, and all health check results.

```bash
curl http://localhost:3847/status/extended
```

```json
// Response 200
{
  "daemon": {
    "uptime": 3742,
    "version": "0.1.0",
    "pid": 12345,
    "memoryMB": 48
  },
  "db": {
    "ok": true,
    "tables": 12,
    "todoCount": 7,
    "memoryCount": 43
  },
  "scheduler": {
    "taskCount": 4,
    "recentResults": [
      {
        "task": "context-watchdog",
        "status": "success",
        "durationMs": 52,
        "ranAt": "2026-02-22T08:57:00.000Z"
      }
    ]
  },
  "checks": {
    "daemon": { "ok": true, "message": "Daemon running" },
    "database": { "ok": true, "message": "Database OK (12 tables)" }
  },
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

---

## Agents

### POST /api/agents/spawn

Spawn a worker agent with a named profile.

```bash
curl -X POST http://localhost:3847/api/agents/spawn \
  -H 'Content-Type: application/json' \
  -d '{"profile": "research", "prompt": "Summarize the top TypeScript testing frameworks"}'
```

```json
// Request body
{
  "profile": "research",      // required — must match a loaded profile name
  "prompt": "Do this task",   // required — task prompt
  "cwd": "/path/to/dir",      // optional — working directory (default: project root)
  "timeoutMs": 60000,         // optional — job timeout in milliseconds
  "maxBudgetUsd": 0.50,       // optional — cost cap in USD
  "spawned_by": "comms"       // optional — defaults to "comms"
}
```

```json
// Response 202
{
  "jobId": "uuid-of-job",
  "status": "spawning",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 202 | `{ "jobId": "...", "status": "spawning", "timestamp": "..." }` |
| 400 | `{ "error": "prompt is required" }` |
| 400 | `{ "error": "profile is required" }` |
| 400 | `{ "error": "Profile research not found" }` |

---

### GET /api/agents

List all agents tracked in the database.

```bash
curl http://localhost:3847/api/agents
```

```json
// Response 200
{
  "data": [
    {
      "id": "agent-uuid",
      "type": "worker",
      "profile": "research",
      "status": "running",
      "tmux_session": null,
      "pid": 98765,
      "started_at": "2026-02-22T09:00:00.000Z",
      "last_activity": "2026-02-22T09:01:00.000Z",
      "state": null,
      "created_at": "2026-02-22T09:00:00.000Z",
      "updated_at": "2026-02-22T09:01:00.000Z"
    }
  ],
  "timestamp": "2026-02-22T09:01:00.000Z"
}
```

---

### GET /api/agents/:id

Get a single agent by ID.

```bash
curl http://localhost:3847/api/agents/agent-uuid
```

```json
// Response 200
{
  "id": "agent-uuid",
  "type": "worker",
  "profile": "research",
  "status": "running",
  "tmux_session": null,
  "pid": 98765,
  "started_at": "2026-02-22T09:00:00.000Z",
  "last_activity": "2026-02-22T09:01:00.000Z",
  "state": null,
  "created_at": "2026-02-22T09:00:00.000Z",
  "updated_at": "2026-02-22T09:01:00.000Z",
  "timestamp": "2026-02-22T09:01:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | Agent object (same shape as items in `GET /api/agents` `data` array) |
| 404 | `{ "error": "Not found" }` |

---

### GET /api/agents/:id/status

Get detailed status for an agent or worker job. Includes token usage and cost for completed jobs.

```bash
curl http://localhost:3847/api/agents/agent-uuid/status
```

```json
// Response 200
{
  "id": "agent-uuid",
  "status": "completed",
  "tokens_in": 4200,
  "tokens_out": 890,
  "cost_usd": 0.0031,
  "timestamp": "2026-02-22T09:05:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | Agent/job status object |
| 404 | `{ "error": "Not found" }` |

---

### PUT /api/agents/:id

Update an agent's status field (used by the orchestrator wrapper during cleanup).

```json
// Request body
{ "status": "stopped" }
```

```json
// Response 200
{
  "status": "updated",
  "id": "agent-uuid",
  "timestamp": "2026-02-22T09:05:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "status": "updated", "id": "...", "timestamp": "..." }` |
| 404 | `{ "error": "Not found" }` |

---

### DELETE /api/agents/:id

Kill a running worker.

```bash
curl -X DELETE http://localhost:3847/api/agents/agent-uuid
```

```json
// Response 200
{
  "status": "killed",
  "timestamp": "2026-02-22T09:05:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "status": "killed", "timestamp": "..." }` |
| 404 | `{ "error": "Not found or not running" }` |

---

### POST /api/agents/:id/activity

Log an activity event for an agent. Also updates `agents.last_activity`.

```bash
curl -X POST http://localhost:3847/api/agents/orchestrator/activity \
  -H 'Content-Type: application/json' \
  -d '{"event_type": "task_received", "details": "Starting research task"}'
```

```json
// Request body
{
  "event_type": "task_received",         // required
  "session_id": "orch1",                 // optional
  "details": "Starting research task"   // optional
}
```

```json
// Response 201
{
  "data": {
    "id": 42,
    "agent_id": "orchestrator",
    "session_id": "orch1",
    "event_type": "task_received",
    "details": "Starting research task",
    "created_at": "2026-02-22T09:00:00.000Z"
  },
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 201 | `{ "data": { /* activity entry */ }, "timestamp": "..." }` |
| 400 | `{ "error": "event_type is required" }` |

---

### GET /api/agents/:id/activity

List activity events for an agent.

```bash
curl "http://localhost:3847/api/agents/orchestrator/activity?limit=50"
curl "http://localhost:3847/api/agents/orchestrator/activity?event_type=task_received"
```

| Query Param | Type | Description |
|-------------|------|-------------|
| `session_id` | string | Filter by session |
| `event_type` | string | Filter by event type |
| `limit` | number | Max results (default 100, max 100) |

```json
// Response 200
{
  "data": [
    {
      "id": 42,
      "agent_id": "orchestrator",
      "session_id": "orch1",
      "event_type": "task_received",
      "details": "Starting research task",
      "created_at": "2026-02-22T09:00:00.000Z"
    }
  ],
  "timestamp": "2026-02-22T09:01:00.000Z"
}
```

---

## Todos

### GET /api/todos

List all todos, ordered by `created_at DESC`.

```bash
curl http://localhost:3847/api/todos
```

```json
// Response 200
{
  "data": [
    {
      "id": 1,
      "title": "Write documentation",
      "description": "API reference and getting started guide",
      "priority": "medium",
      "status": "pending",
      "due_date": null,
      "tags": "[\"docs\",\"v1\"]",
      "created_at": "2026-02-22T00:00:00.000Z",
      "updated_at": "2026-02-22T00:00:00.000Z"
    }
  ],
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

**Note**: `tags` is stored and returned as a JSON string (e.g. `"[\"docs\",\"v1\"]"`). Parse it with `JSON.parse()` if needed.

Valid `status` values: `pending`, `in_progress`, `blocked`, `completed`, `cancelled`.

---

### POST /api/todos

Create a todo.

```bash
curl -X POST http://localhost:3847/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"title": "Review pull request", "priority": "high"}'
```

```json
// Request body
{
  "title": "Review pull request",     // required
  "description": "PR #42",           // optional
  "priority": "high",                 // optional — low | medium | high | critical (default: medium)
  "status": "pending",               // optional — pending | in_progress | blocked | completed | cancelled
  "due_date": "2026-03-01",          // optional — ISO date string
  "tags": ["review", "urgent"]       // optional — stored as JSON string
}
```

```json
// Response 201
{
  "id": 2,
  "title": "Review pull request",
  "description": "PR #42",
  "priority": "high",
  "status": "pending",
  "due_date": "2026-03-01",
  "tags": "[\"review\",\"urgent\"]",
  "created_at": "2026-02-22T09:00:00.000Z",
  "updated_at": "2026-02-22T09:00:00.000Z",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 201 | Full todo object |
| 400 | `{ "error": "title is required" }` |
| 400 | `{ "error": "invalid priority (must be low/medium/high/critical)" }` |
| 400 | `{ "error": "invalid status (must be pending/in_progress/blocked/completed/cancelled)" }` |

---

### GET /api/todos/:id

Get a single todo.

| Status | Response |
|--------|----------|
| 200 | `{ /* todo object */, "timestamp": "..." }` |
| 404 | `{ "error": "Not found" }` |

---

### GET /api/todos/:id/actions

Get the audit trail for a todo — all status and priority changes in chronological order.

```json
// Response 200
{
  "data": [
    {
      "id": 1,
      "todo_id": 42,
      "action": "status_change",
      "old_value": "pending",
      "new_value": "in_progress",
      "note": null,
      "created_at": "2026-02-22T10:00:00.000Z"
    }
  ],
  "timestamp": "2026-02-22T10:00:00.000Z"
}
```

---

### PUT /api/todos/:id

Update a todo. All fields are optional. Status and priority changes are automatically logged to the audit trail.

```json
// Request body (all optional)
{
  "title": "Updated title",
  "description": "Updated description",
  "priority": "critical",
  "status": "in_progress",
  "due_date": "2026-03-15",
  "tags": ["urgent"]
}
```

```json
// Response 200
{
  "id": 2,
  "title": "Updated title",
  "description": "Updated description",
  "priority": "critical",
  "status": "in_progress",
  "due_date": "2026-03-15",
  "tags": "[\"urgent\"]",
  "created_at": "2026-02-22T09:00:00.000Z",
  "updated_at": "2026-02-22T10:00:00.000Z",
  "timestamp": "2026-02-22T10:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | Full updated todo object |
| 400 | Invalid priority or status |
| 404 | `{ "error": "Not found" }` |

---

### DELETE /api/todos/:id

Hard delete a todo.

| Status | Response |
|--------|----------|
| 204 | No body |
| 404 | `{ "error": "Not found" }` |

---

## Calendar

### GET /api/calendar

List calendar events. Optionally filter by date.

```bash
curl http://localhost:3847/api/calendar
curl "http://localhost:3847/api/calendar?date=2026-02-22"
```

| Query Param | Type | Description |
|-------------|------|-------------|
| `date` | string | ISO date (`YYYY-MM-DD`) — filter to events on this date |

```json
// Response 200
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
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

**Note**: `all_day` is stored as an integer (`0` = false, `1` = true).

---

### POST /api/calendar

Create a calendar event.

```bash
curl -X POST http://localhost:3847/api/calendar \
  -H 'Content-Type: application/json' \
  -d '{"title": "Project review", "start_time": "2026-02-25T14:00:00Z"}'
```

```json
// Request body
{
  "title": "Project review",                      // required
  "start_time": "2026-02-25T14:00:00Z",           // required — ISO 8601
  "description": "Q1 project review meeting",    // optional
  "end_time": "2026-02-25T15:00:00Z",             // optional
  "all_day": false,                               // optional (stored as 0/1)
  "source": "manual",                             // optional — origin label
  "todo_ref": 7                                   // optional — foreign key to a todo
}
```

```json
// Response 201
{
  "id": 3,
  "title": "Project review",
  "description": "Q1 project review meeting",
  "start_time": "2026-02-25T14:00:00.000Z",
  "end_time": "2026-02-25T15:00:00.000Z",
  "all_day": 0,
  "source": "manual",
  "todo_ref": 7,
  "created_at": "2026-02-22T09:00:00.000Z",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 201 | Full calendar event object |
| 400 | `{ "error": "title is required" }` |
| 400 | `{ "error": "start_time is required" }` |

---

### GET /api/calendar/:id

Get a single calendar event.

| Status | Response |
|--------|----------|
| 200 | `{ /* event */, "timestamp": "..." }` |
| 404 | `{ "error": "Not found" }` |

---

### PUT /api/calendar/:id

Update a calendar event. All fields optional.

| Status | Response |
|--------|----------|
| 200 | `{ /* updated event */, "timestamp": "..." }` |
| 404 | `{ "error": "Not found" }` |

---

### DELETE /api/calendar/:id

Hard delete a calendar event.

| Status | Response |
|--------|----------|
| 204 | No body |
| 404 | `{ "error": "Not found" }` |

---

## Messages

### POST /api/messages

Send an inter-agent message (logged and auditable).

```bash
curl -X POST http://localhost:3847/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"from": "comms-001", "to": "orchestrator", "body": "Task completed", "type": "result"}'
```

```json
// Request body
{
  "from": "comms-001",            // required — sender agent ID
  "to": "orchestrator",           // required — recipient agent ID
  "body": "Task complete",        // required — message content (NOT "text" or "message")
  "type": "text",                 // optional — text | task | result | error | status (default: "text")
  "metadata": { "priority": 1 }, // optional — arbitrary key/value pairs
  "direct": false                 // optional — true = inject into tmux directly; false = queue for poll loop
}
```

```json
// Response 200
{
  "messageId": "msg-uuid",
  "delivered": true,
  "warning": "optional warning string if applicable",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

**Note**: `warning` is omitted when there is nothing to warn about.

| Status | Response |
|--------|----------|
| 200 | `{ "messageId": "...", "delivered": true/false, "timestamp": "..." }` |
| 400 | `{ "error": "from is required" }` |
| 400 | `{ "error": "to is required" }` |
| 400 | `{ "error": "body is required" }` |
| 403 | `{ "error": "..." }` (worker attempted a restricted send) |

---

### GET /api/messages

Get message history for an agent.

```bash
curl "http://localhost:3847/api/messages?agent=comms-001&limit=20"
curl "http://localhost:3847/api/messages?agent=comms-001&unread=true"
curl "http://localhost:3847/api/messages?agent=comms-001&since_id=42"
```

| Query Param | Type | Required | Description |
|-------------|------|----------|-------------|
| `agent` | string | **yes** | Agent ID to fetch messages for |
| `type` | string | no | Filter by type: `text`, `task`, `result`, `error`, `status` |
| `limit` | number | no | Maximum number of results |
| `unread` | boolean | no | `true` = return unread messages and mark them as read |
| `since_id` | number | no | Return messages with id > N addressed to this agent |

```json
// Response 200
{
  "data": [
    {
      "id": 7,
      "from_agent": "comms",
      "to_agent": "orchestrator",
      "body": "Task complete",
      "type": "result",
      "metadata": null,
      "read_at": null,
      "created_at": "2026-02-22T10:00:00.000Z"
    }
  ],
  "timestamp": "2026-02-22T10:01:00.000Z"
}
```

**Note**: The DB columns are `from_agent` and `to_agent`, not `from` and `to`.

---

### PUT /api/messages/:id/read

Mark a single message as read.

```bash
curl -X PUT http://localhost:3847/api/messages/7/read
```

```json
// Response 200
{
  "marked": 1,
  "id": 7,
  "timestamp": "2026-02-22T10:01:00.000Z"
}
```

---

### PUT /api/messages/read-all

Mark all messages for an agent as read.

```bash
curl -X PUT http://localhost:3847/api/messages/read-all \
  -H 'Content-Type: application/json' \
  -d '{"agent": "comms"}'
```

```json
// Request body
{ "agent": "comms" }   // required
```

```json
// Response 200
{
  "marked": 3,
  "timestamp": "2026-02-22T10:01:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "marked": <count>, "timestamp": "..." }` |
| 400 | `{ "error": "agent is required" }` |

---

## Channel Delivery

### POST /api/send

Deliver a message through the channel router (Telegram, email, etc.).

```bash
curl -X POST http://localhost:3847/api/send \
  -H 'Content-Type: application/json' \
  -d '{"message": "Task complete"}'
```

```json
// Request body
{
  "message": "Task complete",      // required
  "channels": ["telegram"],        // optional — array of channel names; omit to broadcast to all active
  "channel": "telegram",           // alternative singular form (equivalent to ["telegram"])
  "metadata": {}                   // optional
}
```

```json
// Response 200
{
  "results": {
    "telegram": true
  },
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

The `results` object maps channel name to `true` (delivered) or `false` (failed). On delivery failure, the daemon also sends an error message to the comms agent.

| Status | Response |
|--------|----------|
| 200 | `{ "results": { "<channel>": true/false }, "timestamp": "..." }` |
| 400 | `{ "error": "message is required" }` |
| 400 | `{ "error": "Unknown channel(s): X. Registered: Y" }` |

---

## Memory

### POST /api/memory/store

Store a new memory. If vector search is enabled, an embedding is generated automatically.

```bash
curl -X POST http://localhost:3847/api/memory/store \
  -H 'Content-Type: application/json' \
  -d '{"content": "User prefers concise responses", "type": "fact", "tags": ["preferences"]}'
```

```json
// Request body
{
  "content": "User prefers concise responses",  // required
  "type": "fact",                                // optional — fact | episodic | procedural
  "category": "preferences",                    // optional — grouping label
  "tags": ["user", "style"],                    // optional — for filtering
  "source": "conversation",                     // optional — origin label
  "dedup": true                                  // optional — check for vector duplicates before storing
}
```

```json
// Response 201 (stored)
{
  "id": 10,
  "content": "User prefers concise responses",
  "type": "fact",
  "category": "preferences",
  "tags": ["user", "style"],
  "source": "conversation",
  "created_at": "2026-02-22T09:00:00.000Z",
  "updated_at": "2026-02-22T09:00:00.000Z",
  "last_accessed": null,
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

**Note**: `tags` is returned as a parsed array (unlike todos, where it is a raw JSON string).

**Dedup response (200)** — returned when `dedup: true` and similar memories are found:

```json
// Response 200 (dedup candidates found — NOT stored yet)
{
  "action": "review_duplicates",
  "message": "Potential duplicates found — caller decides whether to store",
  "duplicates": [
    {
      "id": 8,
      "content": "User prefers brief output",
      "similarity": 0.87,
      "category": "preferences"
    }
  ],
  "proposed": {
    "content": "User prefers concise responses",
    "type": "fact",
    "category": "preferences",
    "tags": ["user", "style"]
  },
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

When `action: "review_duplicates"` is returned, the memory was **not** stored. Call `/api/memory/store` again without `dedup: true` to force-store it.

| Status | Response |
|--------|----------|
| 201 | Full memory object (stored) |
| 200 | Dedup candidates object (not stored — review required) |
| 400 | `{ "error": "content is required" }` |
| 400 | `{ "error": "type must be fact, episodic, procedural" }` |

---

### POST /api/memory/search

Search memories. Three modes: keyword (default), vector, hybrid.

```bash
# Keyword search
curl -X POST http://localhost:3847/api/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "concise responses", "category": "preferences"}'
```

**Keyword search** — multi-word query uses AND matching; tags use OR matching:

```json
{
  "mode": "keyword",
  "query": "concise responses",    // multi-word = AND matching
  "tags": ["user"],                // optional — OR matching across tags
  "category": "preferences",       // optional — exact match
  "type": "fact",                  // optional — exact match
  "date_from": "2026-01-01",       // optional — ISO date
  "date_to": "2026-12-31"          // optional — ISO date
}
```

**Vector search** — semantic similarity via embeddings:

```json
{
  "mode": "vector",
  "query": "how the user likes to communicate",
  "limit": 10
}
```

**Hybrid search** — combines keyword and vector results:

```json
{
  "mode": "hybrid",
  "query": "response style preferences",
  "limit": 10
}
```

```json
// Response 200
{
  "data": [
    {
      "id": 10,
      "content": "User prefers concise responses",
      "type": "fact",
      "category": "preferences",
      "tags": ["user", "style"],
      "source": "conversation",
      "created_at": "2026-02-22T09:00:00.000Z",
      "updated_at": "2026-02-22T09:00:00.000Z",
      "last_accessed": "2026-02-22T10:00:00.000Z"
    }
  ],
  "mode": "keyword",
  "timestamp": "2026-02-22T10:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "data": [/* memory objects */], "mode": "keyword", "timestamp": "..." }` |
| 400 | `{ "error": "query or at least one filter required" }` (keyword mode, no filters) |
| 400 | `{ "error": "query is required for vector/hybrid search" }` |
| 503 | `{ "error": "Vector search not initialized" }` (sqlite-vec not loaded) |

---

### GET /api/memory/:id

Get a single memory by ID.

| Status | Response |
|--------|----------|
| 200 | `{ /* memory object */, "timestamp": "..." }` |
| 404 | `{ "error": "Not found" }` |

---

### DELETE /api/memory/:id

Hard delete a memory.

| Status | Response |
|--------|----------|
| 204 | No body |
| 404 | `{ "error": "Not found" }` |

---

### POST /api/memory/backfill

Generate embeddings for all memories that are missing them. Requires vector search to be enabled.

```bash
curl -X POST http://localhost:3847/api/memory/backfill
```

```json
// Response 200
{
  "backfilled": 12,
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "backfilled": <count>, "timestamp": "..." }` |
| 503 | `{ "error": "Vector search not initialized" }` |

---

## Config & State

### GET /api/config/:key

Get a stored config entry by key. The value is automatically parsed from JSON.

```bash
curl http://localhost:3847/api/config/theme
```

```json
// Response 200
{
  "key": "theme",
  "value": "dark",
  "updated_at": "2026-02-22T00:00:00.000Z",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | Config entry with parsed value |
| 404 | `{ "error": "Not found" }` |

---

### PUT /api/config/:key

Upsert a config entry. Accepts any JSON-serializable value.

```bash
curl -X PUT http://localhost:3847/api/config/theme \
  -H 'Content-Type: application/json' \
  -d '{"value": "dark"}'
```

```json
// Request body
{ "value": "anything JSON-serializable" }  // required
```

```json
// Response 200
{
  "key": "theme",
  "value": "dark",
  "updated_at": "2026-02-22T09:00:00.000Z",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | Stored config entry |
| 400 | `{ "error": "value is required" }` |

---

### GET /api/feature-state/:feature

Get arbitrary feature state by name.

```bash
curl http://localhost:3847/api/feature-state/voice
```

```json
// Response 200
{
  "feature": "voice",
  "state": { "enabled": true, "engine": "kokoro" },
  "updated_at": "2026-02-22T00:00:00.000Z",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | Feature state with parsed state object |
| 404 | `{ "error": "Not found" }` |

---

### PUT /api/feature-state/:feature

Upsert feature state.

```bash
curl -X PUT http://localhost:3847/api/feature-state/voice \
  -H 'Content-Type: application/json' \
  -d '{"state": {"enabled": true, "engine": "kokoro"}}'
```

```json
// Request body
{ "state": { "enabled": true, "config": {} } }   // required
```

```json
// Response 200
{
  "feature": "voice",
  "state": { "enabled": true, "engine": "kokoro" },
  "updated_at": "2026-02-22T09:00:00.000Z",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | Stored feature state |
| 400 | `{ "error": "state is required" }` |

---

### GET /api/context

Load a structured context summary for session startup — active todos, recent config decisions, in-progress items, upcoming calendar events, and recent memories — within a configurable character budget.

```bash
curl http://localhost:3847/api/context
curl "http://localhost:3847/api/context?budget=4000"
```

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `budget` | number | 8000 | Character budget for the summary |

```json
// Response 200
{
  "active_todos": [
    { "id": 1, "title": "Write docs", "priority": "high", "status": "pending", "due_date": null }
  ],
  "recent_decisions": [
    { "key": "theme", "value": "dark", "updated_at": "2026-02-21T..." }
  ],
  "in_progress": [
    { "id": 2, "title": "Refactor auth", "priority": "medium", "updated_at": "" }
  ],
  "upcoming_calendar": [
    { "id": 3, "title": "Sprint review", "start_time": "2026-02-23T14:00:00Z", "end_time": "2026-02-23T15:00:00Z" }
  ],
  "recent_memories": [
    { "id": 10, "content": "User prefers concise output", "category": "preferences", "created_at": "..." }
  ],
  "token_budget_used": 2341,
  "token_budget_total": 8000,
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

Content is trimmed to fit within the budget — memories drop first, then distant calendar events, then older decisions.

---

### POST /api/config/reload

Hot-reload `kithkit.config.yaml` from disk without restarting the daemon. The scheduler re-reads task definitions and adjusts (adds new, removes deleted, updates changed without interrupting running tasks).

```bash
curl -X POST http://localhost:3847/api/config/reload
```

```json
// Response 200
{
  "message": "Config reloaded successfully",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "message": "Config reloaded successfully", "timestamp": "..." }` |
| 400 | `{ "error": "Config reload failed", "detail": "..." }` |
| 503 | Config watcher not initialized |

---

## Scheduler / Tasks

### GET /api/tasks

List all registered scheduler tasks with their status.

```bash
curl http://localhost:3847/api/tasks
```

```json
// Response 200
{
  "data": [
    {
      "name": "context-watchdog",
      "enabled": true,
      "schedule": "*/3 * * * *",
      "running": false,
      "nextRunAt": "2026-02-22T09:03:00.000Z",
      "lastRunAt": "2026-02-22T09:00:00.000Z"
    },
    {
      "name": "backup",
      "enabled": true,
      "schedule": "0 3 * * 0",
      "running": false,
      "nextRunAt": "2026-02-23T03:00:00.000Z",
      "lastRunAt": null
    }
  ],
  "timestamp": "2026-02-22T09:01:00.000Z"
}
```

---

### POST /api/tasks/:name/run

Manually trigger a task immediately, bypassing its schedule and idle/session checks.

```bash
curl -X POST http://localhost:3847/api/tasks/context-watchdog/run
```

```json
// Response 200
{
  "data": {
    "task_name": "context-watchdog",
    "status": "success",
    "output": "Context at 42%",
    "duration_ms": 48,
    "started_at": "2026-02-22T09:00:00.000Z",
    "finished_at": "2026-02-22T09:00:00.048Z"
  },
  "timestamp": "2026-02-22T09:00:00.048Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "data": /* task result */, "timestamp": "..." }` |
| 404 | `{ "error": "Task not found: name" }` |
| 500 | `{ "error": "Task execution error", "detail": "..." }` |
| 503 | `{ "error": "Scheduler not initialized" }` |

---

### GET /api/tasks/:name/history

Get execution history for a specific task.

```bash
curl http://localhost:3847/api/tasks/context-watchdog/history
```

```json
// Response 200
{
  "data": [
    {
      "id": 1,
      "task_name": "context-watchdog",
      "status": "success",
      "output": "Context at 42%",
      "duration_ms": 48,
      "started_at": "2026-02-22T09:00:00.000Z",
      "finished_at": "2026-02-22T09:00:00.048Z"
    }
  ],
  "timestamp": "2026-02-22T09:01:00.000Z"
}
```

---

## Orchestrator Tasks

Structured task tracking for orchestrator work. The orchestrator is solely responsible for marking tasks completed or failed — the daemon does NOT auto-complete tasks.

State machine: `pending → assigned → in_progress → completed/failed`

### POST /api/orchestrator/tasks

Create a task directly (normally created via `POST /api/orchestrator/escalate`).

```json
// Request body
{
  "title": "Implement feature X",       // required
  "description": "Details...",          // optional
  "priority": 0,                        // optional — 0 (normal), 1 (high), 2 (urgent)
  "work_notes": "Initial context",     // optional
  "timeout_seconds": 300               // optional
}
```

| Status | Response |
|--------|----------|
| 201 | Task object |
| 400 | Missing title or invalid priority |

---

### GET /api/orchestrator/tasks

List tasks. Filter by status with `?status=pending,in_progress`.

```bash
curl 'http://localhost:3847/api/orchestrator/tasks?status=in_progress'
```

Each task in the response includes `worker_count` and `latest_activity`.

---

### GET /api/orchestrator/tasks/:id

Get task detail including workers, activity log, and work_notes.

---

### PUT /api/orchestrator/tasks/:id

Update task status, result, error, or work_notes.

```json
// Mark completed
{"status": "completed", "result": "Summary of what was done"}

// Append work notes (timestamped)
{"work_notes": "Finished subtask 2", "append_work_notes": true}

// Mark failed
{"status": "failed", "error": "Description of failure"}
```

Status transitions are validated: `pending → assigned → in_progress → completed/failed`. Terminal statuses (`completed`, `failed`) cannot be changed.

The `append_work_notes: true` flag appends to existing notes with a timestamp prefix instead of overwriting.

| Status | Response |
|--------|----------|
| 200 | Updated task object |
| 400 | Invalid status or assignee combination |
| 404 | Task not found |
| 409 | Invalid transition or task already terminal |

---

### POST /api/orchestrator/tasks/:id/activity

Post an activity entry for progress visibility. `type: "progress"` entries are forwarded to the comms tmux session.

```json
{"agent": "orchestrator", "type": "progress", "stage": "coding", "message": "Spawned 2 workers"}
```

---

### POST /api/orchestrator/tasks/:id/workers

Assign a worker to a task for tracking.

```json
{"worker_id": "worker-abc123", "role": "coding"}
```

---

## Usage & Metrics

### GET /api/usage

Aggregate token and cost statistics across all worker jobs.

```bash
curl http://localhost:3847/api/usage
```

```json
// Response 200
{
  "tokens_in": 12345,
  "tokens_out": 6789,
  "cost_usd": 0.0412,
  "jobs": 7,
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

---

### GET /api/metrics

Aggregated API request metrics. Useful for diagnosing repeat errors and identifying slow endpoints.

```bash
curl http://localhost:3847/api/metrics
curl "http://localhost:3847/api/metrics?hours=48&endpoint=/api/messages"
curl "http://localhost:3847/api/metrics?agent=comms"
```

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `hours` | number | 24 | Look-back window in hours |
| `endpoint` | string | — | Filter to a specific endpoint path |
| `agent` | string | — | Filter to a specific agent ID |
| `from` | string | — | Start time (ISO 8601 or `YYYY-MM-DD HH`) |
| `to` | string | — | End time (ISO 8601 or `YYYY-MM-DD HH`) |

```json
// Response 200
{
  "summary": {
    "total_requests": 840,
    "success_count": 820,
    "error_4xx": 18,
    "error_5xx": 2,
    "error_rate_4xx": 0.0214,
    "error_rate_5xx": 0.0024,
    "avg_latency_ms": 12.4
  },
  "hourly": [
    {
      "hour": "2026-02-22 08",
      "total_requests": 120,
      "success_count": 118,
      "error_4xx": 2,
      "error_5xx": 0,
      "avg_latency_ms": 11.2
    }
  ],
  "endpoints": [
    {
      "endpoint": "/api/messages",
      "method": "POST",
      "total_requests": 340,
      "error_4xx": 5,
      "error_5xx": 0,
      "avg_latency_ms": 8.1,
      "p95_latency_ms": 22.0
    }
  ],
  "agents": [
    {
      "agent_id": "comms",
      "total_requests": 600,
      "error_4xx": 10,
      "error_5xx": 1,
      "avg_latency_ms": 11.0
    }
  ],
  "top_errors": [
    {
      "endpoint": "/api/messages",
      "method": "POST",
      "total_errors": 5
    }
  ],
  "repeat_offenders": [
    {
      "agent_id": "orchestrator",
      "endpoint": "/api/messages",
      "method": "POST",
      "error_count": 4,
      "latest_hour": "2026-02-22 09"
    }
  ],
  "filters": {
    "endpoint": null,
    "agent": null,
    "from": null,
    "to": null,
    "hours": 24
  },
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

`repeat_offenders` lists agent+endpoint combinations that have produced 3 or more errors across multiple hours — useful for spotting systematic bugs.

---

## Orchestrator

### POST /api/orchestrator/escalate

Escalate a task to the orchestrator. The response shape varies based on the orchestrator's current state.

```bash
curl -X POST http://localhost:3847/api/orchestrator/escalate \
  -H 'Content-Type: application/json' \
  -d '{"task": "Refactor the authentication module", "context": "See issue #42"}'
```

```json
// Request body
{
  "task": "Refactor the authentication module",   // required — task description
  "context": "See issue #42",                      // optional — background context
  "priority": 0                                    // optional — integer, higher = more urgent
}
```

**Three possible success responses** depending on orchestrator state:

```json
// Response 202 — orchestrator was dead, now spawned
{
  "status": "spawned",
  "session": "orch1",
  "task_id": "uuid",
  "message": "Orchestrator session created with task",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

```json
// Response 200 — orchestrator is running and idle (waiting)
{
  "status": "escalated",
  "task_id": "uuid",
  "message": "Task sent to waiting orchestrator",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

```json
// Response 200 — orchestrator is busy (Claude actively running)
{
  "status": "queued",
  "task_id": "uuid",
  "message": "Task queued — orchestrator is busy, wrapper will pick it up between runs",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

In all three cases, a row is created in `orchestrator_tasks` with the returned `task_id`. Track task progress with `GET /api/orchestrator/tasks/:id`.

| Status | Response |
|--------|----------|
| 202 | Orchestrator spawned (was dead) |
| 200 | Task escalated or queued (orchestrator already running) |
| 400 | `{ "error": "task is required" }` |
| 500 | `{ "error": "Failed to spawn orchestrator session" }` |

---

### GET /api/orchestrator/status

Check orchestrator session status.

```bash
curl http://localhost:3847/api/orchestrator/status
```

```json
// Response 200
{
  "alive": true,
  "state": "active",
  "status": "running",
  "started_at": "2026-02-22T08:00:00.000Z",
  "last_activity": "2026-02-22T09:00:00.000Z",
  "active_jobs": 2,
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `alive` | boolean | Whether the tmux session exists |
| `state` | string | Fine-grained: `"active"` (Claude running), `"waiting"` (idle loop), `"dead"` |
| `status` | string | DB status: `"running"`, `"stopped"`, `"not_registered"` |
| `started_at` | string \| null | When the session was started |
| `last_activity` | string \| null | When activity was last recorded |
| `active_jobs` | number | Count of queued/running worker jobs |

---

### POST /api/orchestrator/shutdown

Gracefully shut down the orchestrator session.

```bash
curl -X POST http://localhost:3847/api/orchestrator/shutdown
curl -X POST http://localhost:3847/api/orchestrator/shutdown \
  -H 'Content-Type: application/json' \
  -d '{"force": true, "reason": "manual shutdown"}'
```

```json
// Request body (all optional)
{
  "force": false,             // optional — skip waiting for active task to complete
  "reason": "manual"         // optional — reason for logging
}
```

```json
// Response 200 — shutdown requested
{
  "status": "shutdown_requested",
  "timeout_ms": 60000,
  "was_active": false,
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

```json
// Response 200 — already stopped
{
  "status": "already_stopped",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

**Note**: The shutdown is asynchronous. If the orchestrator does not exit within `timeout_ms`, the daemon force-kills it. If `was_active` is `true`, the timeout is extended to 3 minutes to allow the current task to complete.

---

### POST /api/orchestrator/tasks

Create a task in the orchestrator queue.

```bash
curl -X POST http://localhost:3847/api/orchestrator/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Audit documentation", "description": "Check all docs for accuracy", "priority": 1}'
```

```json
// Request body
{
  "title": "Audit documentation",       // required
  "description": "Check all docs",     // optional
  "priority": 1,                        // optional — 0 (normal), 1 (high), 2 (urgent); default 0
  "timeout_seconds": 300                // optional — task-level timeout
}
```

```json
// Response 201
{
  "id": "uuid",
  "title": "Audit documentation",
  "description": "Check all docs",
  "status": "pending",
  "assignee": null,
  "priority": 1,
  "result": null,
  "error": null,
  "timeout_seconds": null,
  "created_at": "2026-02-22T09:00:00.000Z",
  "assigned_at": null,
  "started_at": null,
  "completed_at": null,
  "updated_at": "2026-02-22T09:00:00.000Z",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 201 | Full task object |
| 400 | `{ "error": "title is required" }` |
| 400 | `{ "error": "priority must be 0 (normal), 1 (high), or 2 (urgent)" }` |

---

### GET /api/orchestrator/tasks

List orchestrator tasks. Filter by status (comma-separated for multiple).

```bash
curl "http://localhost:3847/api/orchestrator/tasks?status=pending"
curl "http://localhost:3847/api/orchestrator/tasks?status=pending,in_progress"
curl http://localhost:3847/api/orchestrator/tasks
```

| Query Param | Type | Description |
|-------------|------|-------------|
| `status` | string | Filter: `pending`, `assigned`, `in_progress`, `completed`, `failed` — comma-separated for multiple |

```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "title": "Audit documentation",
      "description": "Check all docs",
      "status": "pending",
      "assignee": null,
      "priority": 1,
      "result": null,
      "error": null,
      "timeout_seconds": null,
      "created_at": "2026-02-22T09:00:00.000Z",
      "assigned_at": null,
      "started_at": null,
      "completed_at": null,
      "updated_at": "2026-02-22T09:00:00.000Z",
      "worker_count": 0,
      "latest_activity": null
    }
  ],
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

**Note**: List items include `worker_count` and `latest_activity` (the most recent activity entry or `null`), which are not present on the base task object from `POST /api/orchestrator/tasks`.

---

### GET /api/orchestrator/tasks/:id

Get a single task with its workers and full activity log.

```bash
curl http://localhost:3847/api/orchestrator/tasks/uuid
```

```json
// Response 200
{
  "id": "uuid",
  "title": "Audit documentation",
  "description": "Check all docs",
  "status": "in_progress",
  "assignee": "orchestrator",
  "priority": 1,
  "result": null,
  "error": null,
  "timeout_seconds": null,
  "created_at": "2026-02-22T09:00:00.000Z",
  "assigned_at": "2026-02-22T09:01:00.000Z",
  "started_at": "2026-02-22T09:01:30.000Z",
  "completed_at": null,
  "updated_at": "2026-02-22T09:01:30.000Z",
  "workers": [
    {
      "task_id": "uuid",
      "worker_id": "worker-abc",
      "role": "research",
      "assigned_at": "2026-02-22T09:01:00.000Z"
    }
  ],
  "activity": [
    {
      "id": 1,
      "task_id": "uuid",
      "agent": "daemon",
      "type": "note",
      "stage": "status_change",
      "message": "Status -> in_progress",
      "created_at": "2026-02-22T09:01:30.000Z"
    }
  ],
  "activity_total": 1,
  "timestamp": "2026-02-22T09:02:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | Task object with `workers` array, `activity` array, and `activity_total` count |
| 404 | `{ "error": "Task not found" }` |

---

### PUT /api/orchestrator/tasks/:id

Update a task (status, assignee, result). Status transitions are enforced — see the [Common Pitfalls](#orchestrator-task-status-transitions-are-enforced) section.

```bash
curl -X PUT "http://localhost:3847/api/orchestrator/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"status": "completed", "result": "All docs updated successfully"}'
```

```json
// Request body (all optional)
{
  "status": "completed",                          // pending | assigned | in_progress | completed | failed
  "assignee": "orchestrator",                     // null clears assignee; required when status = "assigned"
  "result": "All docs updated successfully",     // store task result (typically set on completion)
  "error": "Reason for failure"                   // store error detail (typically set on failure)
}
```

```json
// Response 200 — updated task object (base fields only, no workers/activity)
{
  "id": "uuid",
  "title": "Audit documentation",
  "status": "completed",
  "assignee": "orchestrator",
  "result": "All docs updated successfully",
  "error": null,
  "completed_at": "2026-02-22T10:00:00.000Z",
  "updated_at": "2026-02-22T10:00:00.000Z",
  "timestamp": "2026-02-22T10:00:00.000Z"
}
```

On status change to `completed` or `failed`, the daemon automatically:
- Sends a `result` message to the `comms` agent
- Injects a notification into the comms tmux session

| Status | Response |
|--------|----------|
| 200 | Updated task object |
| 400 | `{ "error": "invalid status: X" }` |
| 400 | `{ "error": "pending tasks must have null assignee" }` |
| 400 | `{ "error": "assigned tasks require a non-null assignee" }` |
| 404 | `{ "error": "Task not found" }` |
| 409 | `{ "error": "Cannot update completed task" }` (terminal state) |
| 409 | `{ "error": "cannot transition from X to Y", "allowed_transitions": [...] }` |

---

### POST /api/orchestrator/tasks/:id/activity

Post an activity entry to a task's log. `progress` entries are forwarded immediately to the comms tmux session.

```bash
curl -X POST "http://localhost:3847/api/orchestrator/tasks/$TASK_ID/activity" \
  -H 'Content-Type: application/json' \
  -d '{"message": "Completed 3 of 5 subtasks", "type": "progress", "agent": "orchestrator", "stage": "execution"}'
```

```json
// Request body
{
  "message": "Completed 3 of 5 subtasks",  // required — NOT "event_type" or "details"
  "type": "progress",                        // optional — progress | note (default: "note")
  "agent": "orchestrator",                  // optional — who posted this (default: "unknown")
  "stage": "execution"                      // optional — label for the current phase
}
```

```json
// Response 201
{
  "id": 5,
  "task_id": "uuid",
  "agent": "orchestrator",
  "type": "progress",
  "stage": "execution",
  "message": "Completed 3 of 5 subtasks",
  "created_at": "2026-02-22T09:05:00.000Z",
  "timestamp": "2026-02-22T09:05:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 201 | Activity entry object |
| 400 | `{ "error": "message is required" }` |
| 400 | `{ "error": "type must be one of: progress, note" }` |
| 404 | `{ "error": "Task not found" }` |

---

### GET /api/orchestrator/tasks/:id/activity

Get the activity log for a task (paginated).

```bash
curl "http://localhost:3847/api/orchestrator/tasks/$TASK_ID/activity?limit=20&offset=0"
```

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `limit` | number | 50 | Max entries (capped at 200) |
| `offset` | number | 0 | Pagination offset |

```json
// Response 200
{
  "data": [
    {
      "id": 1,
      "task_id": "uuid",
      "agent": "daemon",
      "type": "note",
      "stage": "status_change",
      "message": "Status -> in_progress",
      "created_at": "2026-02-22T09:01:30.000Z"
    }
  ],
  "total": 1,
  "timestamp": "2026-02-22T09:02:00.000Z"
}
```

---

### POST /api/orchestrator/tasks/:id/workers

Assign a worker job to a task.

```bash
curl -X POST "http://localhost:3847/api/orchestrator/tasks/$TASK_ID/workers" \
  -H 'Content-Type: application/json' \
  -d '{"worker_id": "worker-job-uuid", "role": "research"}'
```

```json
// Request body
{
  "worker_id": "worker-job-uuid",   // required — NOT "jobId"
  "role": "research"                // optional — descriptive label for this worker's role
}
```

```json
// Response 201
{
  "task_id": "uuid",
  "worker_id": "worker-job-uuid",
  "role": "research",
  "assigned_at": "2026-02-22T09:01:00.000Z",
  "timestamp": "2026-02-22T09:01:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 201 | Worker assignment object |
| 400 | `{ "error": "worker_id is required" }` |
| 404 | `{ "error": "Task not found" }` |
| 409 | `{ "error": "Cannot assign workers to completed task" }` |
| 409 | `{ "error": "Worker already assigned to this task" }` |

---

## Timers

### POST /api/timer

Create a self-reminder timer. Fires once, then nags every 30 seconds until acknowledged. Auto-expires after 10 minutes.

```bash
curl -X POST http://localhost:3847/api/timer \
  -H 'Content-Type: application/json' \
  -d '{"delay": "90s", "message": "Check worker results", "agent": "comms"}'
```

```json
// Request body
{
  "delay": "90s",                    // required — seconds (number) or string with unit: "90s", "2m"
  "message": "Check worker results", // required — reminder text
  "agent": "comms"                   // optional — "comms" or "orchestrator" (default: "comms")
}
```

```json
// Response 201
{
  "id": "timer-uuid",
  "fires_at": "2026-02-22T09:01:30.000Z",
  "message": "Check worker results",
  "status": "pending",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 201 | `{ "id": "...", "fires_at": "...", "message": "...", "status": "pending", "timestamp": "..." }` |
| 400 | `{ "error": "delay is required — number (seconds) or string with unit (e.g. \"2m\", \"90s\")" }` |
| 400 | `{ "error": "message is required" }` |

---

### GET /api/timers

List all timers (active and recently completed).

```bash
curl http://localhost:3847/api/timers
```

```json
// Response 200
{
  "timers": [
    {
      "id": "timer-uuid",
      "session": "comms",
      "message": "Check worker results",
      "fires_at": "2026-02-22T09:01:30.000Z",
      "created_at": "2026-02-22T09:00:00.000Z",
      "status": "pending",
      "fired_at": null,
      "completed_at": null
    }
  ],
  "count": 1,
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

**Note**: The response key is `timers` (not `data`), and `count` is included alongside it.

Timer status values: `pending`, `fired`, `acknowledged`, `snoozed`, `expired`, `cancelled`.

---

### POST /api/timer/:id/ack

Acknowledge a timer (stops nagging).

```bash
curl -X POST "http://localhost:3847/api/timer/$TIMER_ID/ack"
```

```json
// Response 200
{
  "id": "timer-uuid",
  "acknowledged": true,
  "timestamp": "2026-02-22T09:01:35.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "id": "...", "acknowledged": true, "timestamp": "..." }` |
| 404 | `{ "error": "Timer not found" }` |
| 409 | `{ "error": "Timer is pending, not fired" }` (must be in `fired` state) |

---

### POST /api/timer/:id/snooze

Snooze a timer. Default snooze is 5 minutes.

```bash
curl -X POST "http://localhost:3847/api/timer/$TIMER_ID/snooze" \
  -H 'Content-Type: application/json' \
  -d '{"delay": 120}'
```

```json
// Request body (optional)
{ "delay": 300 }  // snooze duration in seconds (default: 300)
```

```json
// Response 200
{
  "id": "timer-uuid",
  "snoozed": true,
  "fires_at": "2026-02-22T09:06:35.000Z",
  "timestamp": "2026-02-22T09:01:35.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "id": "...", "snoozed": true, "fires_at": "...", "timestamp": "..." }` |
| 404 | `{ "error": "Timer not found" }` |
| 409 | `{ "error": "Timer is pending, not fired" }` (must be in `fired` state) |

---

### DELETE /api/timer/:id

Cancel a timer.

```bash
curl -X DELETE "http://localhost:3847/api/timer/$TIMER_ID"
```

```json
// Response 200
{
  "id": "timer-uuid",
  "cancelled": true,
  "timestamp": "2026-02-22T09:01:00.000Z"
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "id": "...", "cancelled": true, "timestamp": "..." }` |
| 404 | `{ "error": "Timer not found" }` |

---

## A2A Messaging

Unified endpoint for sending agent-to-agent messages — DMs and group messages with automatic route selection.

### `POST /api/a2a/send`

Send a message to another agent (DM) or to a group.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | One of `to`/`group` | Peer name (e.g. `"bmo"`) or qualified name (e.g. `"bmo@relay.kithkit.com"`) |
| `group` | string | One of `to`/`group` | Group UUID or group name |
| `payload` | object | Yes | Message payload — must include `type` |
| `payload.type` | string | Yes | Message type (e.g. `"text"`, `"task"`, `"result"`) |
| `payload.text` | string | No | Message text content |
| `route` | string | No | Routing mode: `"auto"` (default), `"lan"`, or `"relay"` |

**Constraints:**
- Exactly one of `to` or `group` is required (not both).
- `route: "lan"` cannot be used with group targets.
- Peer names are resolved case-insensitively from `agent-comms.peers` config; bare names are auto-qualified for relay.

**Routing behavior:**

| Route | Behavior |
|-------|----------|
| `auto` (default) | Tries LAN first (if peer in config), falls back to relay |
| `lan` | LAN only — requires peer in `agent-comms.peers` config + Keychain secret |
| `relay` | Relay only — uses network SDK |

Groups always route via relay regardless of `route` value.

**Success response (DM):**

```json
{
  "ok": true,
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "target": "bmo",
  "targetType": "dm",
  "route": "lan",
  "status": "delivered",
  "attempts": [
    { "route": "lan", "status": "success", "latencyMs": 42 }
  ],
  "timestamp": "2026-03-03T12:00:00.000Z"
}
```

**Success response (Group):**

```json
{
  "ok": true,
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "target": "c006dfce-37b6-434a-8407-1d227f485a81",
  "targetType": "group",
  "route": "relay",
  "status": "delivered",
  "attempts": [
    { "route": "relay", "status": "success", "latencyMs": 120 }
  ],
  "delivered": ["bmo@relay.kithkit.com", "r2d2@relay.kithkit.com"],
  "queued": [],
  "failed": [],
  "timestamp": "2026-03-03T12:00:00.000Z"
}
```

**Error response:**

```json
{
  "ok": false,
  "error": "Peer 'unknown-agent' not found in agent-comms config",
  "code": "PEER_NOT_FOUND",
  "attempts": [],
  "timestamp": "2026-03-03T12:00:00.000Z"
}
```

**Error codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_REQUEST` | 400 | Missing or malformed request body or payload |
| `INVALID_TARGET` | 400 | Missing/invalid `to`/`group`, or both specified |
| `INVALID_ROUTE` | 400 | Invalid route value, or `lan` with group target |
| `PEER_NOT_FOUND` | 404 | Peer name not found in `agent-comms.peers` config |
| `GROUP_NOT_FOUND` | 404 | Group UUID or name not found |
| `DELIVERY_FAILED` | 502 | All delivery attempts failed |
| `RELAY_UNAVAILABLE` | 503 | Network SDK not initialized |
| `LAN_UNAVAILABLE` | 503 | Keychain secret not found |

**`attempts` array:** Each delivery attempt includes:

| Field | Type | Description |
|-------|------|-------------|
| `route` | `"lan"` \| `"relay"` | Which route was tried |
| `status` | `"success"` \| `"failed"` | Attempt outcome |
| `error` | string? | Error message (on failure) |
| `latencyMs` | number | Round-trip time in milliseconds |
| `relayStatus` | `"delivered"` \| `"queued"`? | Relay-specific delivery status |

**Examples:**

```bash
# DM with auto routing
curl -X POST http://localhost:3847/api/a2a/send \
  -H 'Content-Type: application/json' \
  -d '{"to": "bmo", "payload": {"type": "text", "text": "Hello BMO!"}}'

# Group message
curl -X POST http://localhost:3847/api/a2a/send \
  -H 'Content-Type: application/json' \
  -d '{"group": "c006dfce-37b6-434a-8407-1d227f485a81", "payload": {"type": "text", "text": "Hello team!"}}'

# Force LAN route
curl -X POST http://localhost:3847/api/a2a/send \
  -H 'Content-Type: application/json' \
  -d '{"to": "bmo", "payload": {"type": "text", "text": "LAN only"}, "route": "lan"}'

# Force relay route
curl -X POST http://localhost:3847/api/a2a/send \
  -H 'Content-Type: application/json' \
  -d '{"to": "bmo", "payload": {"type": "text", "text": "Via relay"}, "route": "relay"}'
```

### Deprecated Endpoints

These older endpoints still work but are deprecated. Use `POST /api/a2a/send` instead.

| Endpoint | Status | Migration |
|----------|--------|-----------|
| `POST /agent/send` | Deprecated | Use `POST /api/a2a/send` with `{"to": "<peer>", "payload": {"type": "<type>", "text": "<text>"}}` |
| `POST /api/network/send` | Deprecated | Use `POST /api/a2a/send` — same `{to, payload}` shape |
| `POST /api/network/message` | Deprecated | Use `POST /api/a2a/send` — wrap string message as `{"to": "<peer>", "payload": {"type": "message", "text": "<msg>"}}` |
| `POST /api/network/groups/:id/send` | Deprecated | Use `POST /api/a2a/send` with `{"group": "<id>", "payload": {...}}` |

All deprecated endpoints return `Deprecation: true` and `Link: </api/a2a/send>; rel="successor-version"` response headers.

---

## Error Responses

All error responses follow a consistent shape:

```json
{
  "error": "Human-readable error message",
  "detail": "Optional additional detail",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request — missing required fields or invalid values |
| 403 | Forbidden — access control violation |
| 404 | Not found — resource or endpoint does not exist |
| 409 | Conflict — state machine violation or duplicate |
| 413 | Payload too large — request body exceeds size limit |
| 500 | Internal server error — unhandled exception |
| 503 | Service unavailable — required subsystem not initialized |

---

## Extension Routes

Extensions can add custom routes via `registerRoute()` (see [Extensions](extensions.md)). Extension routes are checked after core API routes and before the 404 fallback. If the daemon is in degraded mode (extension init failed), extension routes are skipped.

To see which extension routes are registered:

```bash
curl http://localhost:3847/health | jq '.extensionRoutes'
```
