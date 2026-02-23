# Config, Health, Status & Usage API Reference

Configuration CRUD, feature state, context loader, usage stats, and health/status endpoints.

## Health & Status

### GET /health

Basic daemon health check.

```bash
curl http://localhost:3847/health
```

**Response (200):**
```json
{
  "status": "ok",
  "uptime": 3742,
  "version": "0.1.0",
  "timestamp": "2026-02-22T09:00:00.000Z",
  "degraded": false,
  "extension": "bmo",
  "extensionRoutes": ["/agent/send", "/agent/message", "/agent/status"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Always `"ok"` |
| `uptime` | number | Seconds since daemon start |
| `degraded` | boolean | `true` if extension init failed |
| `extension` | string \| null | Registered extension name |
| `extensionRoutes` | string[] | Routes from the extension |

---

### GET /health/extended

Run all health checks (daemon + database + extension-registered checks).

```bash
curl http://localhost:3847/health/extended

# Human-readable format
curl -H 'Accept: text/plain' http://localhost:3847/health/extended
```

**Response (200):**
```json
{
  "status": "ok",
  "uptime": 3742,
  "version": "0.1.0",
  "checks": {
    "daemon": { "ok": true, "message": "Daemon running", "details": { "uptime": 3742, "pid": 12345, "memoryMB": 48 } },
    "database": { "ok": true, "message": "Database OK (12 tables)", "details": { "tables": 12 } }
  },
  "timestamp": "..."
}
```

Overall `status` is `"ok"` only if all checks pass; otherwise `"degraded"`.

---

### GET /status

Quick status check.

```bash
curl http://localhost:3847/status
```

**Response (200):**
```json
{
  "daemon": "running",
  "agent": "BMO",
  "uptime": 3742.5,
  "timestamp": "..."
}
```

---

### GET /status/extended

Full operational status — daemon info, DB stats, recent scheduler results, health checks.

```bash
curl http://localhost:3847/status/extended
```

**Response (200):**
```json
{
  "daemon": { "uptime": 3742, "version": "0.1.0", "pid": 12345, "memoryMB": 48 },
  "db": { "ok": true, "tables": 12, "todoCount": 7, "memoryCount": 43 },
  "scheduler": {
    "taskCount": 4,
    "recentResults": [
      { "task": "context-watchdog", "status": "success", "durationMs": 52, "ranAt": "2026-02-22T08:57:00.000Z" }
    ]
  },
  "checks": {
    "daemon": { "ok": true, "message": "Daemon running" },
    "database": { "ok": true, "message": "Database OK (12 tables)" }
  },
  "timestamp": "..."
}
```

---

## Config Key-Value Store

### GET /api/config/:key

Get a stored config entry. Value is auto-parsed from JSON.

```bash
curl http://localhost:3847/api/config/theme
```

**Response (200):**
```json
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

**Request body:** `{ "value": <any JSON-serializable value> }`

Returns 200 with the stored entry. Creates if not exists, updates if exists.

**Gotchas:**
- This is a key-value store in the `config` table — separate from `kithkit.config.yaml`
- Values are JSON-serialized on write and parsed on read
- Use for runtime config decisions (theme, preferences, etc.)

---

## POST /api/config/reload

Hot-reload `kithkit.config.yaml` from disk without restarting the daemon.

```bash
curl -X POST http://localhost:3847/api/config/reload
```

| Status | Response |
|--------|----------|
| 200 | `{ "message": "Config reloaded successfully" }` |
| 400 | `{ "error": "Config reload failed", "detail": "..." }` |
| 503 | `{ "error": "Config watcher not initialized" }` |

**What it does:**
- Re-reads `kithkit.config.yaml` from disk
- Scheduler re-reads task definitions (adds new, removes deleted, updates changed)
- Running tasks are not interrupted

---

## Feature State

### GET /api/feature-state/:feature

Get arbitrary feature state by name.

```bash
curl http://localhost:3847/api/feature-state/voice
```

**Response (200):**
```json
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

**Request body:** `{ "state": <any JSON-serializable object> }`

Returns 200 with the stored feature state. Upserts (creates or updates).

---

## Context Summary

### GET /api/context

Load a structured context summary for session startup — active todos, recent config decisions, in-progress items, upcoming calendar events, and recent memories.

```bash
curl http://localhost:3847/api/context
curl "http://localhost:3847/api/context?budget=4000"
```

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `budget` | number | 8000 | Character budget for the summary |

**Response (200):**
```json
{
  "active_todos": [{ "id": 1, "title": "Write docs", "priority": "high", "status": "pending" }],
  "recent_decisions": [{ "key": "theme", "value": "dark", "updated_at": "..." }],
  "in_progress": [{ "id": 2, "title": "Refactor auth", "priority": "medium" }],
  "upcoming_calendar": [{ "id": 3, "title": "Sprint review", "start_time": "...", "end_time": "..." }],
  "recent_memories": [{ "id": 10, "content": "User prefers concise output", "category": "preferences" }],
  "token_budget_used": 2341,
  "token_budget_total": 8000,
  "timestamp": "..."
}
```

**Gotchas:**
- Content is trimmed to fit the budget — memories drop first, then distant calendar events, then older decisions
- Useful for startup context injection without loading everything

---

## Usage & Metrics

### GET /api/usage

Aggregate token and cost statistics across all worker jobs.

```bash
curl http://localhost:3847/api/usage
```

**Response (200):**
```json
{
  "tokens_in": 12345,
  "tokens_out": 6789,
  "cost_usd": 0.0412,
  "jobs": 7,
  "timestamp": "..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `tokens_in` | number | Total input tokens across all jobs |
| `tokens_out` | number | Total output tokens |
| `cost_usd` | number | Total estimated cost (rounded to 4 decimals) |
| `jobs` | number | Total worker job count |

---

## Common Error Responses

All error responses follow this shape:

```json
{
  "error": "Human-readable error message",
  "detail": "Optional additional detail",
  "timestamp": "2026-02-22T09:00:00.000Z"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request — missing fields or invalid values |
| 403 | Forbidden — access control violation |
| 404 | Not found |
| 413 | Request body too large (>1MB) |
| 500 | Internal server error |
| 503 | Service unavailable — subsystem not initialized |
