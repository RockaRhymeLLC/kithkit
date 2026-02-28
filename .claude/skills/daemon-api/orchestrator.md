# Orchestrator API Reference

Escalate tasks, check orchestrator status, and request shutdown.

## POST /api/orchestrator/escalate

Send a task to the orchestrator. Spawns a new orchestrator tmux session if one isn't already running.

```bash
curl -X POST http://localhost:3847/api/orchestrator/escalate \
  -H 'Content-Type: application/json' \
  -d '{"task": "Refactor the auth module", "context": "Using passport.js, need to add OAuth"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | string | yes | Description of the task to perform |
| `context` | string | no | Additional background context |

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| 202 | `{ "status": "spawned", "session": "bmo-orch", "message": "..." }` | New orchestrator session created |
| 200 | `{ "status": "escalated", "message": "Task sent to running orchestrator" }` | Task injected into existing session |
| 400 | `{ "error": "task is required" }` | Missing or non-string task field |
| 500 | `{ "error": "Failed to spawn orchestrator session" }` | tmux spawn failure |

**What happens on spawn:**
1. Creates a session directory at `.claude/sessions/orchestrator`
2. Creates an `orchestrator_tasks` row (status: `pending`) and returns `task_id` in response
3. Builds a system prompt with the task, task ID, relevant memories (via hybrid search), and context
4. Spawns `bmo-orch` tmux session running Claude CLI
5. Registers orchestrator in the `agents` table
6. Logs `session_start` activity event
7. Sends the task as a message from `comms` to `orchestrator`

**If already running:**
- Creates an `orchestrator_tasks` row and returns `task_id`
- The task is sent as a message (type: `task`) to the existing orchestrator
- No new session is created

**Response now includes `task_id`:**
```json
{ "status": "spawned", "session": "bmo-orch", "task_id": "uuid-here", "message": "..." }
{ "status": "escalated", "task_id": "uuid-here", "message": "..." }
```

**Gotchas:**
- The Claude binary must be at `~/.local/bin/claude` — it's not in the daemon's default PATH
- The orchestrator gets relevant memories injected into its initial prompt automatically
- Session auto-exits when Claude finishes, but DB status may need manual sync

---

## Orchestrator Task Queue

All escalated tasks are tracked in the `orchestrator_tasks` table. Use this to avoid duplicates and track progress.

### Schema: orchestrator_tasks

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `title` | TEXT NOT NULL | Task title |
| `description` | TEXT | Full task description |
| `status` | TEXT NOT NULL | `pending` → `assigned` → `in_progress` → `completed` / `failed` |
| `assignee` | TEXT | Worker/agent ID assigned |
| `priority` | INTEGER | 0=normal, 1=high, 2=urgent |
| `result` | TEXT | Task result (on completion) |
| `error` | TEXT | Error message (on failure) |
| `timeout_seconds` | INTEGER | Optional timeout |
| `created_at` | TEXT | ISO timestamp |
| `assigned_at` | TEXT | When assigned |
| `started_at` | TEXT | When work began |
| `completed_at` | TEXT | When finished |
| `updated_at` | TEXT | Last update |

Related tables: `orchestrator_task_workers` (task_id + worker_id + role), `orchestrator_task_activity` (progress log).

### Before Escalating: Check for Duplicates

Before calling `POST /api/orchestrator/escalate`, query existing tasks to avoid creating duplicates:

```bash
curl -s 'http://localhost:3847/api/orchestrator/tasks?status=pending,assigned,in_progress'
```

Review the returned tasks. If a matching or closely related task already exists, either wait for it or update it rather than creating a new one.

### After Escalating: Track the Task ID

The escalation response now includes `task_id`. Save this to monitor progress:

```bash
# Check task status
curl -s http://localhost:3847/api/orchestrator/tasks/<task_id>

# View activity log
curl -s http://localhost:3847/api/orchestrator/tasks/<task_id>/activity
```

### Task Queue Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/orchestrator/tasks` | Create a task manually |
| `GET` | `/api/orchestrator/tasks` | List tasks (`?status=pending,in_progress`) |
| `GET` | `/api/orchestrator/tasks/:id` | Get task detail (+ workers + activity) |
| `PUT` | `/api/orchestrator/tasks/:id` | Update task (status, assignee, result, error) |
| `POST` | `/api/orchestrator/tasks/:id/activity` | Post progress/note entry |
| `GET` | `/api/orchestrator/tasks/:id/activity` | Get activity log (paginated) |
| `POST` | `/api/orchestrator/tasks/:id/workers` | Assign worker to task |

---

## GET /api/orchestrator/status

Check if the orchestrator is alive and its current state.

```bash
curl http://localhost:3847/api/orchestrator/status
```

**Response (200):**
```json
{
  "alive": true,
  "status": "running",
  "started_at": "2026-02-22T09:00:00.000Z",
  "last_activity": "2026-02-22T09:15:00.000Z",
  "active_jobs": 2,
  "timestamp": "..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `alive` | boolean | Whether the tmux session is running |
| `status` | string | DB status: `running`, `stopped`, `not_registered` |
| `started_at` | string \| null | When the session was spawned |
| `last_activity` | string \| null | Last activity log timestamp |
| `active_jobs` | number | Count of worker jobs in `queued` or `running` state |

---

## POST /api/orchestrator/shutdown

Request graceful shutdown of the orchestrator.

```bash
curl -X POST http://localhost:3847/api/orchestrator/shutdown
```

**Responses:**

| Status | Body |
|--------|------|
| 200 | `{ "status": "shutdown_requested", "timeout_ms": 60000 }` |
| 200 | `{ "status": "already_stopped" }` |

**Shutdown sequence:**
1. Sends a shutdown message (from: `daemon`, to: `orchestrator`, type: `status`)
2. Sets a 60-second timeout
3. If no acknowledgment within 60s, force-kills the tmux session
4. Updates agents table status to `stopped`
5. Logs `session_end` activity event

**Gotchas:**
- The orchestrator should finish in-flight work and send results to comms before exiting
- Force-kill happens at 60s regardless — orchestrator should wrap up faster than that
