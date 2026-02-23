# Agents API Reference

Agent lifecycle management — spawn workers, check status, kill, and activity logging.

## POST /api/agents/spawn

Spawn a worker agent with a named profile.

```bash
curl -X POST http://localhost:3847/api/agents/spawn \
  -H 'Content-Type: application/json' \
  -d '{"profile": "research", "prompt": "Summarize TypeScript testing frameworks"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `profile` | string | yes | Must match a loaded profile name (e.g., `research`, `coding`, `testing`) |
| `prompt` | string | yes | Task prompt for the worker |
| `cwd` | string | no | Working directory (default: project root) |
| `timeoutMs` | number | no | Job timeout in milliseconds |
| `maxBudgetUsd` | number | no | Cost cap in USD |

**Responses:**

| Status | Body |
|--------|------|
| 202 | `{ "jobId": "...", "status": "spawning", "timestamp": "..." }` |
| 400 | `{ "error": "prompt is required" }` |
| 400 | `{ "error": "profile is required" }` |
| 400 | `{ "error": "Profile 'X' not found" }` |

**Gotchas:**
- Profile must be loaded from `.claude/agents/*.md` — if the profile file doesn't exist, you get a 400
- Workers are ephemeral — they run, report results, and exit
- The `jobId` returned is used to check status and kill the worker

---

## GET /api/agents

List all agents tracked in the database (workers, orchestrator, comms).

```bash
curl http://localhost:3847/api/agents
```

**Response (200):**
```json
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

## GET /api/agents/:id

Get a single agent by ID.

```bash
curl http://localhost:3847/api/agents/agent-uuid
```

| Status | Response |
|--------|----------|
| 200 | Agent object |
| 404 | `{ "error": "Not found" }` |

---

## GET /api/agents/:id/status

Get detailed status for an agent or job. Checks worker_jobs first, then agents table.

```bash
curl http://localhost:3847/api/agents/job-uuid/status
```

**Response (200):**
```json
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
| 200 | Agent/job status with token usage (for completed jobs) |
| 404 | `{ "error": "Not found" }` |

---

## DELETE /api/agents/:id

Kill a running worker.

```bash
curl -X DELETE http://localhost:3847/api/agents/agent-uuid
```

| Status | Response |
|--------|----------|
| 200 | `{ "status": "killed", "timestamp": "..." }` |
| 404 | `{ "error": "Not found or not running" }` |

---

## POST /api/agents/:id/activity

Log an activity event for an agent. Also updates `agents.last_activity` and `agents.updated_at`.

```bash
curl -X POST http://localhost:3847/api/agents/orchestrator/activity \
  -H 'Content-Type: application/json' \
  -d '{"event_type": "task_completed", "details": "Built the feature"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_type` | string | yes | One of: `session_start`, `session_end`, `task_received`, `task_completed`, `context_checkpoint`, `error`, `shutdown_reason` |
| `details` | string | no | Brief description |
| `session_id` | string | no | Session identifier |

**Responses:**

| Status | Body |
|--------|------|
| 201 | `{ "data": { "id": 1, "agent_id": "...", "event_type": "...", ... }, "timestamp": "..." }` |
| 400 | `{ "error": "event_type is required" }` |
| 400 | Invalid event_type throws an error |

**Valid event types:** `session_start`, `session_end`, `task_received`, `task_completed`, `context_checkpoint`, `error`, `shutdown_reason`

---

## GET /api/agents/:id/activity

List activity events for an agent with optional filters.

```bash
curl "http://localhost:3847/api/agents/orchestrator/activity?event_type=task_completed&limit=10"
```

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `session_id` | string | — | Filter by session |
| `event_type` | string | — | Filter by event type |
| `limit` | number | 100 | Max results (capped at 1000) |

**Response (200):**
```json
{
  "data": [
    {
      "id": 1,
      "agent_id": "orchestrator",
      "session_id": "bmo-orch",
      "event_type": "task_completed",
      "details": "Built the feature",
      "created_at": "2026-02-22T09:01:00.000Z"
    }
  ],
  "timestamp": "..."
}
```
