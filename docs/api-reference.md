# Kithkit Daemon API Reference

The daemon runs a local HTTP server on `127.0.0.1:<port>` (default 3847). It binds to localhost only — no remote access. All JSON responses include a `timestamp` field (ISO 8601). Invalid JSON bodies return `400 { "error": "Invalid JSON" }`.

## Table of Contents

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
  "maxBudgetUsd": 0.50        // optional — cost cap in USD
}
```

| Status | Response |
|--------|----------|
| 202 | `{ "jobId": "...", "status": "spawning", "timestamp": "..." }` |
| 400 | `{ "error": "prompt is required" }` |
| 400 | `{ "error": "profile is required" }` |
| 400 | `{ "error": "Profile 'X' not found" }` |

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
  "timestamp": "..."
}
```

---

### GET /api/agents/:id

Get a single agent by ID.

| Status | Response |
|--------|----------|
| 200 | `{ /* agent object */, "timestamp": "..." }` |
| 404 | `{ "error": "Not found" }` |

---

### GET /api/agents/:id/status

Get detailed status for an agent or job. Includes token usage and cost for completed jobs.

```json
// Response 200
{
  "id": "agent-uuid",
  "status": "completed",
  "tokens_in": 4200,
  "tokens_out": 890,
  "cost_usd": 0.0031,
  "timestamp": "..."
}
```

| Status | Response |
|--------|----------|
| 200 | Agent/job status object |
| 404 | `{ "error": "Not found" }` |

---

### DELETE /api/agents/:id

Kill a running worker.

| Status | Response |
|--------|----------|
| 200 | `{ "status": "killed", "timestamp": "..." }` |
| 404 | `{ "error": "Not found or not running" }` |

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
  "timestamp": "..."
}
```

**Note**: `tags` is stored as a JSON string.

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
  "status": "pending",               // optional — pending | in_progress | completed | cancelled
  "due_date": "2026-03-01",          // optional — ISO date string
  "tags": ["review", "urgent"]       // optional — JSON-serialized on storage
}
```

| Status | Response |
|--------|----------|
| 201 | `{ /* todo object */, "timestamp": "..." }` |
| 400 | Missing title, invalid priority, or invalid status |

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
  "timestamp": "..."
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

| Status | Response |
|--------|----------|
| 200 | `{ /* updated todo */, "timestamp": "..." }` |
| 400 | Invalid priority or status |
| 404 | Not found |

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

| Status | Response |
|--------|----------|
| 201 | `{ /* calendar event */, "timestamp": "..." }` |
| 400 | Missing title or start_time |

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
| 404 | Not found |

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
  -d '{"from": "comms-001", "to": "worker-007", "body": "Task completed"}'
```

```json
// Request body
{
  "from": "comms-001",            // required — sender agent ID
  "to": "worker-007",             // required — recipient agent ID
  "body": "Task complete",        // required — message content
  "type": "text",                 // optional — defaults to "text"
  "metadata": { "priority": 1 }  // optional — arbitrary key/value pairs
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "messageId": "...", "delivered": true, "timestamp": "..." }` |
| 400 | Missing from, to, or body |
| 403 | Worker attempted a restricted send |

---

### GET /api/messages

Get message history for an agent.

```bash
curl "http://localhost:3847/api/messages?agent=comms-001&limit=20"
```

| Query Param | Type | Required | Description |
|-------------|------|----------|-------------|
| `agent` | string | yes | Agent ID to fetch messages for |
| `type` | string | no | Filter by message type |
| `limit` | number | no | Maximum number of results |

```json
// Response 200
{
  "data": [
    {
      "id": "msg-uuid",
      "from": "comms-001",
      "to": "worker-007",
      "body": "Task complete",
      "type": "text",
      "metadata": null,
      "created_at": "2026-02-22T10:00:00.000Z"
    }
  ],
  "timestamp": "..."
}
```

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
  "channels": ["telegram"],        // optional — specific channels; omit for all active
  "metadata": {}                   // optional
}
```

| Status | Response |
|--------|----------|
| 200 | `{ "results": /* channel router result */, "timestamp": "..." }` |
| 400 | Missing message |

The channel router reads the active channel from `kithkit.config.yaml` and forwards to the matching adapter. See `docs/recipes/` for channel-specific setup (Telegram, email, etc.).

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
  "tags": ["user", "style"],                    // optional — for OR-match filtering
  "source": "conversation"                      // optional — origin label
}
```

| Status | Response |
|--------|----------|
| 201 | `{ "id": 1, "content": "...", "type": "fact", "category": "preferences", "tags": "[\"user\",\"style\"]", "source": "conversation", "created_at": "...", "updated_at": "...", "timestamp": "..." }` |
| 400 | Missing content or invalid type |

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

| Status | Response |
|--------|----------|
| 200 | `{ "data": [/* memory objects */], "mode": "keyword", "timestamp": "..." }` |
| 400 | Missing query or filters |
| 503 | Vector search not initialized (sqlite-vec not loaded) |

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
  "timestamp": "..."
}
```

| Status | Response |
|--------|----------|
| 200 | Config entry with parsed value |
| 404 | Not found |

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
{ "value": "anything JSON-serializable" }
```

Returns 200 with the stored entry.

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
  "timestamp": "..."
}
```

| Status | Response |
|--------|----------|
| 200 | Feature state with parsed state object |
| 404 | Not found |

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
{ "state": { "enabled": true, "config": {} } }
```

Returns 200 with the stored feature state.

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
  "timestamp": "..."
}
```

Content is trimmed to fit within the budget — memories drop first, then distant calendar events, then older decisions.

---

### POST /api/config/reload

Hot-reload `kithkit.config.yaml` from disk without restarting the daemon. The scheduler re-reads task definitions and adjusts (adds new, removes deleted, updates changed without interrupting running tasks).

```bash
curl -X POST http://localhost:3847/api/config/reload
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
  "timestamp": "..."
}
```

---

### POST /api/tasks/:name/run

Manually trigger a task immediately, bypassing its schedule and idle/session checks.

```bash
curl -X POST http://localhost:3847/api/tasks/context-watchdog/run
curl -X POST http://localhost:3847/api/tasks/backup/run
```

| Status | Response |
|--------|----------|
| 200 | `{ "data": /* task result */, "timestamp": "..." }` |
| 404 | `{ "error": "Task not found: name" }` |
| 500 | `{ "error": "Task execution error", "detail": "..." }` |
| 503 | `{ "error": "Scheduler not initialized" }` |

The task result includes `task_name`, `status` (`success` | `failure`), `output`, `duration_ms`, `started_at`, and `finished_at`.

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
  "timestamp": "..."
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
  "timestamp": "..."
}
```

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
| 500 | Internal server error — unhandled exception |
| 503 | Service unavailable — required subsystem not initialized |

---

## Extension Routes

Extensions can add custom routes via `registerRoute()` (see [Extensions](extensions.md)). Extension routes are checked after core API routes and before the 404 fallback. If the daemon is in degraded mode (extension init failed), extension routes are skipped.

To see which extension routes are registered:

```bash
curl http://localhost:3847/health | jq '.extensionRoutes'
```
