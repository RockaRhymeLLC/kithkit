# Kithkit Daemon API Reference

The daemon runs a local HTTP server on `127.0.0.1:<port>` (default 3847). All responses include a `timestamp` field (ISO 8601). Invalid JSON bodies return `400 { error: "Invalid JSON" }`.

## Health & Status

### GET /health

Returns daemon health information.

```json
// Response 200
{
  "status": "ok",
  "uptime": 3742,
  "version": "0.1.0",
  "timestamp": "2026-02-22T00:00:00.000Z"
}
```

### GET /status

Quick status check.

```json
// Response 200
{
  "daemon": "running",
  "agent": "MyAgent",
  "uptime": 3742.5,
  "timestamp": "2026-02-22T00:00:00.000Z"
}
```

---

## Agents

### POST /api/agents/spawn

Spawn a worker agent with a named profile.

```json
// Request body
{
  "profile": "research",     // required — must match a loaded profile name
  "prompt": "Find X",        // required — task prompt
  "cwd": "/path/to/dir",     // optional — working directory
  "timeoutMs": 60000,        // optional — job timeout
  "maxBudgetUsd": 0.50       // optional — cost cap
}
```

| Status | Response |
|--------|----------|
| 202 | `{ jobId, status, timestamp }` |
| 400 | `{ error: "prompt is required" }` or `"profile is required"` or `"Profile X not found"` |

### GET /api/agents

List all agents.

```json
// Response 200
{ "data": [ /* agent objects */ ], "timestamp": "..." }
```

### GET /api/agents/:id

Get a single agent by ID.

| Status | Response |
|--------|----------|
| 200 | `{ /* agent object */, timestamp }` |
| 404 | `{ error: "Not found" }` |

### GET /api/agents/:id/status

Get detailed status for an agent or job.

| Status | Response |
|--------|----------|
| 200 | `{ /* job or agent status */, timestamp }` — includes `tokens_in`, `tokens_out`, `cost_usd` for completed jobs |
| 404 | `{ error: "Not found" }` |

### DELETE /api/agents/:id

Kill a running worker.

| Status | Response |
|--------|----------|
| 200 | `{ status: "killed", timestamp }` |
| 404 | `{ error: "Not found or not running" }` |

---

## Todos

### GET /api/todos

List all todos, ordered by `created_at DESC`.

```json
// Response 200
{
  "data": [
    {
      "id": 1,
      "title": "Write docs",
      "description": "API reference and getting started guide",
      "priority": "medium",
      "status": "pending",
      "due_date": null,
      "tags": "[\"docs\"]",
      "created_at": "2026-02-22T00:00:00.000Z",
      "updated_at": "2026-02-22T00:00:00.000Z"
    }
  ],
  "timestamp": "..."
}
```

### POST /api/todos

Create a todo.

```json
// Request body
{
  "title": "Write docs",           // required
  "description": "Full API ref",   // optional
  "priority": "medium",            // optional — low | medium | high | critical
  "status": "pending",             // optional — pending | in_progress | completed | cancelled
  "due_date": "2026-03-01",        // optional
  "tags": ["docs", "v1"]           // optional — JSON-serialized
}
```

| Status | Response |
|--------|----------|
| 201 | `{ /* todo object */, timestamp }` |
| 400 | Validation error (missing title, invalid priority/status) |

### GET /api/todos/:id

Get a single todo. Returns 200 or 404.

### GET /api/todos/:id/actions

Get the audit trail for a todo (status/priority changes).

```json
// Response 200
{ "data": [ /* action records ordered by created_at ASC */ ], "timestamp": "..." }
```

### PUT /api/todos/:id

Update a todo. All fields optional. Status and priority changes are logged.

| Status | Response |
|--------|----------|
| 200 | `{ /* updated todo */, timestamp }` |
| 400 | Validation error |
| 404 | Not found |

### DELETE /api/todos/:id

Hard delete. Returns 204 (no body) or 404.

---

## Calendar

### GET /api/calendar

List calendar events. Optional date filter.

| Query Param | Type | Description |
|-------------|------|-------------|
| `date` | string | ISO date — filter to events on this date |

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
      "source": null,
      "todo_ref": null,
      "created_at": "2026-02-22T00:00:00.000Z"
    }
  ],
  "timestamp": "..."
}
```

### POST /api/calendar

Create a calendar event.

```json
// Request body
{
  "title": "Meeting",             // required
  "start_time": "2026-02-22T09:00:00Z",  // required
  "description": "Weekly sync",   // optional
  "end_time": "2026-02-22T10:00:00Z",    // optional
  "all_day": false,               // optional (stored as 0/1)
  "source": "manual",             // optional
  "todo_ref": 5                   // optional — FK to todos
}
```

| Status | Response |
|--------|----------|
| 201 | `{ /* calendar event */, timestamp }` |
| 400 | Missing title or start_time |

### GET /api/calendar/:id

Get a single event. Returns 200 or 404.

### PUT /api/calendar/:id

Update a calendar event. All fields optional. Returns 200 or 404.

### DELETE /api/calendar/:id

Hard delete. Returns 204 (no body) or 404.

---

## Messages

### POST /api/messages

Send an inter-agent message.

```json
// Request body
{
  "from": "comms-001",           // required — sender agent ID
  "to": "orchestrator-001",     // required — recipient agent ID
  "body": "Handle this task",   // required — message content
  "type": "text",               // optional — defaults to "text"
  "metadata": {}                // optional — arbitrary key/value pairs
}
```

| Status | Response |
|--------|----------|
| 200 | `{ messageId, delivered: true, timestamp }` |
| 400 | Missing from/to/body |
| 403 | Worker attempted restricted send |

### GET /api/messages

Get message history for an agent.

| Query Param | Type | Required | Description |
|-------------|------|----------|-------------|
| `agent` | string | yes | Agent ID |
| `type` | string | no | Filter by message type |
| `limit` | number | no | Max results |

```json
// Response 200
{ "data": [ /* message records */ ], "timestamp": "..." }
```

---

## Channel Delivery

### POST /api/send

Deliver a message through the channel router (Telegram, email, etc.).

```json
// Request body
{
  "message": "Hello!",          // required
  "channels": ["telegram"],     // optional — specific channels; omit for all active
  "metadata": {}                // optional
}
```

| Status | Response |
|--------|----------|
| 200 | `{ results: /* channel router result */, timestamp }` |
| 400 | Missing message |

---

## Memory

### POST /api/memory/store

Store a new memory. Automatically generates an embedding if vector search is enabled.

```json
// Request body
{
  "content": "Dave prefers dark mode",  // required
  "type": "fact",                        // optional — fact | episodic | procedural
  "category": "preferences",            // optional
  "tags": ["user", "ui"],               // optional
  "source": "conversation"              // optional
}
```

| Status | Response |
|--------|----------|
| 201 | `{ id, content, type, category, tags, source, created_at, updated_at, timestamp }` |
| 400 | Missing content or invalid type |

### POST /api/memory/search

Search memories. Three modes: keyword (default), vector, hybrid.

```json
// Keyword search
{
  "mode": "keyword",
  "query": "dark mode",        // multi-word = AND matching
  "tags": ["user"],            // optional — OR matching
  "category": "preferences",  // optional — exact match
  "type": "fact",              // optional
  "date_from": "2026-01-01",  // optional
  "date_to": "2026-12-31"     // optional
}

// Vector search
{
  "mode": "vector",
  "query": "user interface preferences",
  "limit": 10
}

// Hybrid search
{
  "mode": "hybrid",
  "query": "dark mode preference",
  "limit": 10
}
```

| Status | Response |
|--------|----------|
| 200 | `{ data: [/* memories */], mode, timestamp }` |
| 400 | Missing query or filters |
| 503 | Vector search not initialized (sqlite-vec not loaded) |

### GET /api/memory/:id

Get a single memory. Returns 200 or 404.

### DELETE /api/memory/:id

Hard delete. Returns 204 (no body) or 404.

---

## Config & State

### GET /api/config/:key

Get a stored config entry. Value is auto-parsed from JSON.

| Status | Response |
|--------|----------|
| 200 | `{ key, value, updated_at, timestamp }` |
| 404 | Not found |

### PUT /api/config/:key

Upsert a config entry.

```json
// Request body
{ "value": "anything JSON-serializable" }
```

Returns 200 with the stored entry.

### GET /api/feature-state/:feature

Get arbitrary feature state.

| Status | Response |
|--------|----------|
| 200 | `{ feature, state, updated_at, timestamp }` |
| 404 | Not found |

### PUT /api/feature-state/:feature

Upsert feature state.

```json
// Request body
{ "state": { "enabled": true, "config": {} } }
```

Returns 200 with the stored state.

### POST /api/config/reload

Hot-reload `kithkit.config.yaml` from disk without restarting the daemon.

| Status | Response |
|--------|----------|
| 200 | `{ message: "Config reloaded successfully", timestamp }` |
| 400 | `{ error: "Config reload failed", detail: "..." }` |
| 503 | Config watcher not initialized |

---

## Usage & Metrics

### GET /api/usage

Aggregate token and cost stats across all worker jobs.

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

## Scheduler

### GET /api/tasks

List all registered scheduler tasks.

```json
// Response 200
{
  "data": [
    {
      "name": "email-check",
      "enabled": true,
      "schedule": "*/15 * * * *",
      "running": false,
      "nextRunAt": "2026-02-22T00:15:00.000Z",
      "lastRunAt": "2026-02-22T00:00:00.000Z"
    }
  ],
  "timestamp": "..."
}
```

### POST /api/tasks/:name/run

Manually trigger a task immediately, bypassing idle/busy checks.

| Status | Response |
|--------|----------|
| 200 | `{ data: /* task result */, timestamp }` |
| 404 | Task not found |
| 500 | Task execution error |
| 503 | Scheduler not initialized |

### GET /api/tasks/:name/history

Get execution history for a task.

```json
// Response 200
{ "data": [ /* history records */ ], "timestamp": "..." }
```
