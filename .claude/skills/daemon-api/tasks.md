# Tasks (Scheduler) API Reference

List scheduled tasks, manually trigger them, and view execution history.

## GET /api/tasks

List all registered scheduler tasks with their current status.

```bash
curl http://localhost:3847/api/tasks
```

**Response (200):**
```json
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
      "name": "orchestrator-idle",
      "enabled": true,
      "schedule": "*/5 * * * *",
      "running": false,
      "nextRunAt": "2026-02-22T09:05:00.000Z",
      "lastRunAt": null
    }
  ],
  "timestamp": "..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Task identifier |
| `enabled` | boolean | Whether the task is active |
| `schedule` | string | Cron expression or interval |
| `running` | boolean | Whether the task is currently executing |
| `nextRunAt` | string \| null | Next scheduled execution |
| `lastRunAt` | string \| null | Last execution time |

**Gotchas:**
- Returns empty `data: []` if scheduler is not initialized (no error)
- Tasks are defined in `kithkit.config.yaml` under `scheduler.tasks` and registered via `registerCoreTasks()`

---

## POST /api/tasks/:name/run

Manually trigger a task immediately. Bypasses schedule and idle/session checks.

```bash
curl -X POST http://localhost:3847/api/tasks/context-watchdog/run
```

**Responses:**

| Status | Body |
|--------|------|
| 200 | `{ "data": { "task_name": "...", "status": "success", "output": "...", "duration_ms": 52, "started_at": "...", "finished_at": "..." } }` |
| 404 | `{ "error": "Task not found: name" }` |
| 500 | `{ "error": "Task execution error", "detail": "..." }` |
| 503 | `{ "error": "Scheduler not initialized" }` |

**Task result fields:**

| Field | Type | Description |
|-------|------|-------------|
| `task_name` | string | Which task ran |
| `status` | string | `success` or `failure` |
| `output` | string | Task output/result text |
| `duration_ms` | number | Execution time in milliseconds |
| `started_at` | string | ISO timestamp when execution began |
| `finished_at` | string | ISO timestamp when execution ended |

**Gotchas:**
- Manual trigger bypasses idle checks — useful for debugging/testing
- Task name must be URL-encoded if it contains special characters
- The result is also saved to the `task_results` table for history

---

## GET /api/tasks/:name/history

Get execution history for a specific task.

```bash
curl http://localhost:3847/api/tasks/context-watchdog/history
```

**Response (200):**
```json
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

**Gotchas:**
- History is persisted in the `task_results` SQLite table
- Returns empty array for tasks that have never run — not a 404
