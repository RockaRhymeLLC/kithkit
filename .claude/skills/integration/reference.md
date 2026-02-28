# Kithkit Integration Reference

## Daemon API — Full Request/Response Details

All endpoints on `localhost:3847`. JSON responses include `timestamp` (ISO 8601). Invalid JSON bodies return `400 { "error": "Invalid JSON" }`.

### Health & Status

**GET /health** — Daemon health and extension status.

```json
{
  "status": "ok",
  "uptime": 3742,
  "version": "0.1.0",
  "degraded": false,
  "extension": "my-agent",
  "extensionRoutes": ["/my-ext/status", "/my-ext/*"],
  "timestamp": "..."
}
```

**GET /health/extended** — Run all health checks. Accepts `Accept: text/plain`.

```json
{
  "status": "ok",
  "checks": {
    "daemon": { "ok": true, "message": "Daemon running", "details": { "uptime": 3742, "pid": 12345, "memoryMB": 48 } },
    "database": { "ok": true, "message": "Database OK (12 tables)" }
  }
}
```

**GET /status** — Quick status: `{ "daemon": "running", "agent": "AgentName", "uptime": 3742.5 }`

**GET /status/extended** — Aggregated operational status including DB stats, scheduler results, and health checks.

### Agents

**POST /api/agents/spawn** — Spawn a worker.

```json
{
  "profile": "research",
  "prompt": "Do this task",
  "cwd": "/path/to/dir",
  "timeoutMs": 60000,
  "maxBudgetUsd": 0.50
}
```

Response 202: `{ "jobId": "...", "status": "spawning" }`

**GET /api/agents** — List all agents.

**GET /api/agents/:id** — Get agent details (404 if not found).

**GET /api/agents/:id/status** — Detailed status with token usage and cost.

```json
{ "id": "...", "status": "completed", "tokens_in": 4200, "tokens_out": 890, "cost_usd": 0.0031 }
```

**DELETE /api/agents/:id** — Kill a running worker.

### Todos

**GET /api/todos** — List all todos (ordered by `created_at DESC`). Tags stored as JSON string.

**POST /api/todos** — Create a todo.

```json
{
  "title": "Review PR",
  "description": "PR #42",
  "priority": "high",
  "status": "pending",
  "due_date": "2026-03-01",
  "tags": ["review", "urgent"]
}
```

Priority: `low | medium | high | critical`. Status: `pending | in_progress | completed | cancelled`.

**GET /api/todos/:id** — Get a single todo.

**GET /api/todos/:id/actions** — Audit trail (status/priority changes).

**PUT /api/todos/:id** — Update (all fields optional, changes logged).

**DELETE /api/todos/:id** — Hard delete (204 No Content).

### Calendar

**GET /api/calendar** — List events. Filter: `?date=2026-02-22`.

**POST /api/calendar** — Create event.

```json
{
  "title": "Project review",
  "start_time": "2026-02-25T14:00:00Z",
  "description": "Q1 review",
  "end_time": "2026-02-25T15:00:00Z",
  "all_day": false,
  "source": "manual",
  "todo_ref": 7
}
```

**GET/PUT/DELETE /api/calendar/:id** — CRUD operations.

### Messages

**POST /api/messages** — Inter-agent message.

```json
{
  "from": "comms-001",
  "to": "worker-007",
  "body": "Task complete",
  "type": "text",
  "metadata": { "priority": 1 }
}
```

**GET /api/messages?agent=X&type=Y&limit=20** — Message history (agent required).

### Channel Delivery

**POST /api/send** — Deliver through channel router.

```json
{
  "message": "Task complete",
  "channels": ["telegram"],
  "metadata": {}
}
```

Omit `channels` to send to all active. Router reads channel config and forwards to matching adapters.

### Memory

**POST /api/memory/store** — Store a memory.

```json
{
  "content": "User prefers concise responses",
  "type": "fact",
  "category": "preferences",
  "tags": ["user", "style"],
  "source": "conversation"
}
```

Types: `fact | episodic | procedural`.

**POST /api/memory/search** — Search memories. Three modes:

Keyword (default): multi-word AND matching, tags OR matching.
```json
{ "mode": "keyword", "query": "concise responses", "tags": ["user"], "category": "preferences" }
```

Vector: semantic similarity via embeddings.
```json
{ "mode": "vector", "query": "how the user likes to communicate", "limit": 10 }
```

Hybrid: combines keyword and vector results.
```json
{ "mode": "hybrid", "query": "response style", "limit": 10 }
```

**GET /api/memory/:id** — Get a single memory.

**DELETE /api/memory/:id** — Hard delete (204).

### Config & State

**GET /api/config/:key** — Get config entry (value auto-parsed from JSON).

**PUT /api/config/:key** — Upsert config: `{ "value": "anything JSON-serializable" }`.

**GET /api/feature-state/:feature** — Get feature state.

**PUT /api/feature-state/:feature** — Upsert: `{ "state": { "enabled": true } }`.

**GET /api/context** — Structured context summary for session startup. Budget: `?budget=4000` (default 8000 chars).

**POST /api/config/reload** — Hot-reload `kithkit.config.yaml`. Scheduler adjusts without restart.

### Scheduler / Tasks

**GET /api/tasks** — List all tasks with status, schedule, next/last run times.

**POST /api/tasks/:name/run** — Manual trigger (bypasses schedule and idle checks).

Result: `{ "task_name": "...", "status": "success", "output": "...", "duration_ms": 48 }`.

**GET /api/tasks/:name/history** — Execution history for a task.

### Usage & Metrics

**GET /api/usage** — Aggregate stats: `{ "tokens_in": 12345, "tokens_out": 6789, "cost_usd": 0.0412, "jobs": 7 }`.

## Error Responses

All errors follow: `{ "error": "message", "detail": "optional", "timestamp": "..." }`.

| Status | Meaning |
|--------|---------|
| 400 | Bad request — missing fields or invalid values |
| 403 | Forbidden — access control violation |
| 404 | Not found |
| 500 | Internal server error |
| 503 | Service unavailable — subsystem not initialized |

## Extension Interface

```typescript
export interface Extension {
  name: string;
  onInit?(config: KithkitConfig, server: http.Server): Promise<void>;
  onRoute?(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, searchParams: URLSearchParams): Promise<boolean>;
  onShutdown?(): Promise<void>;
}
```

## TaskHandler Interface

```typescript
type TaskHandler = (context: { taskName: string; config: Record<string, unknown> }) => Promise<void>;
```

## EmailProvider Interface

Shared by all email integrations (Graph, Himalaya, JMAP, Outlook IMAP):

```typescript
interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  date: string;
  body: string;
  bodyHtml?: string;
  isRead: boolean;
  folder?: string;
}

interface SendOptions {
  cc?: string[];
  bcc?: string[];
  replyToId?: string;
  isHtml?: boolean;
}

interface EmailProvider {
  name: string;
  isConfigured(): boolean;
  listInbox(limit?: number, unreadOnly?: boolean): Promise<EmailMessage[]>;
  readEmail(id: string): Promise<EmailMessage | null>;
  markAsRead(id: string): Promise<void>;
  moveEmail?(id: string, folder: string): Promise<void>;
  searchEmails(query: string, limit?: number): Promise<EmailMessage[]>;
  sendEmail(to: string, subject: string, body: string, options?: SendOptions): Promise<void>;
}
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `todos` / `todo_actions` | Todos with audit trail |
| `memories` | Facts, decisions, episodic (with optional vector embeddings) |
| `calendar` | Events, reminders, deadlines |
| `messages` | Inter-agent message log |
| `agents` / `worker_jobs` | Agent registry and job tracking |
| `config` / `feature_state` | Runtime config and per-feature state |
| `task_results` | Scheduler execution history |

## Config Structure

```yaml
agent:
  name: MyAgent
  identity_file: identity.md

daemon:
  port: 3847
  log_level: info
  log_dir: logs

scheduler:
  tasks:
    - name: my-task
      interval: "1h"
      enabled: true
      config:
        requires_session: false
        idle_only: false

security:
  rate_limits:
    incoming_max_per_minute: 5
    outgoing_max_per_minute: 10
```
