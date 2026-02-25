# Spec: Orchestrator Communication & Task Management v2

**Created**: 2026-02-25
**Status**: Draft
**Issue**: RockaRhymeLLC/kithkit#24

## Goal

Make the orchestrator reliable under concurrent workloads by adding a structured task queue, fixing the notification flooding problem, enabling direct agent-to-agent dialogue, and establishing proactive progress reporting up the chain.

## Background

3 of 6 orchestrator spawns failed on 2026-02-25 due to message flooding. Root causes identified:

1. **No task queue** — Escalations arrive as tmux injections that interrupt active processing. No structured storage, no priority, no status tracking.
2. **Notification flooding** — Two independent 60-second loops (`message-delivery` Phase 2 and `comms-heartbeat`) re-notify about unread messages indefinitely, with no coordination between them. The orchestrator gets pinged every ~30 seconds (offset cycles) for every unread message until it reads them.
3. **No direct dialogue** — Comms and orchestrator communicate via store-poll-notify: message inserted → scheduler tick → tmux injection → agent polls API. Round-trip latency is up to 60 seconds for a simple question.
4. **No progress visibility** — The orchestrator sends only final results. Comms (and the human) see silence during work, which is indistinguishable from failure.

Design principle (from Dave): *"I work with you, you work with the orch, orch works with workers. We all summarize up the chain. The orch does the heavy lifting so comms stays available for me."*

## Requirements

### Must Have

- [ ] **Task queue table** (`orchestrator_tasks`) in SQLite with status lifecycle: `pending → assigned → in_progress → completed / failed`
- [ ] **Task injection API**: `POST /api/orchestrator/tasks` — comms creates tasks, returns task ID
- [ ] **Task query API**: `GET /api/orchestrator/tasks` — filterable by status, returns all tasks with worker assignments
- [ ] **Task update API**: `PUT /api/orchestrator/tasks/:id` — orchestrator updates status, assigns workers, posts results
- [ ] **Worker linkage**: Tasks track which worker IDs are assigned to them
- [ ] **Deliver-once notifications**: A message is injected into a tmux session exactly once. No re-notification loops.
- [ ] **Notification receipt tracking**: `notified_at` on messages, set on first successful injection. No `repingUnreadMessages` phase.
- [ ] **Remove `comms-heartbeat` message re-notification**: The heartbeat should only report worker completions, not re-ping unread messages (that's message-delivery's job, and it should do it once).
- [ ] **Activity log API**: `POST /api/orchestrator/tasks/:id/activity` — agents post progress updates and notes
- [ ] **Progress forwarding**: Daemon forwards progress updates to comms session automatically
- [ ] **Escalation creates a task**: `POST /api/orchestrator/escalate` writes to the task queue (not just a message) and spawns the orchestrator if needed

### Should Have

- [ ] **Direct agent channel**: Lightweight request/reply between comms and orchestrator without going through the full message-delivery pipeline
- [ ] **Task priority field**: `priority` (0=normal, 1=high, 2=urgent) with queue ordering
- [ ] **Task timeout**: Configurable per-task timeout with automatic `failed` transition on expiry
- [ ] **Progress summary for humans**: Comms formats progress updates into human-readable summaries before relaying to Dave

### Won't Have (v1)

- Task dependencies or DAGs — each task is independent for now
- Subtask decomposition (`parent_task_id`) — deferred to v2; v1 tasks are flat
- Cross-orchestrator task handoff — one orchestrator at a time
- Web UI for task queue — API-only, comms relays status verbally
- Worker-to-worker direct communication — workers only talk to the orchestrator

## Constraints

### Security

None beyond existing localhost-only daemon boundary. All new APIs are internal.

### Performance

- Task queue operations must complete in <10ms (SQLite single-table queries)
- Progress updates must reach comms within 2 seconds of being posted
- Direct agent channel round-trip must be <5 seconds

### Compatibility

- Zero breaking changes to existing `POST /api/orchestrator/escalate` — existing callers continue to work, now backed by task queue
- Existing `POST /api/messages` continues to work — the change is in notification delivery behavior
- `GET /api/messages?unread=true` remains the primary read path for agents

## Success Criteria

1. Comms can escalate 5 tasks in rapid succession; all are queued and the orchestrator processes them sequentially without any being lost or causing crashes
2. An unread message is notified exactly once — not re-pinged on subsequent scheduler cycles
3. The orchestrator posts at least 3 progress updates per complex task (e.g., "reading code", "spawning workers", "synthesizing results")
4. Progress updates appear in the comms session within 2 seconds
5. `GET /api/orchestrator/tasks` returns accurate, real-time status for all queued/active/completed tasks
6. The orchestrator can ask comms a clarifying question and receive an answer within one scheduler tick (~5 seconds for direct channel)
7. Worker assignments are visible on task records (`GET /api/orchestrator/tasks/:id` shows linked worker IDs)

## User Stories / Scenarios

### Scenario 1: Rapid-fire task escalation

- **Given**: Orchestrator is idle, comms has 3 tasks to escalate
- **When**: Comms sends 3 `POST /api/orchestrator/escalate` requests in quick succession
- **Then**: All 3 tasks appear in `orchestrator_tasks` with status `pending`. Orchestrator is spawned (if dead) or notified once. Orchestrator pulls tasks from the queue in order, processes each to completion. No tasks are lost or duplicated.

### Scenario 2: Deliver-once notification

- **Given**: Comms sends a message to the orchestrator
- **When**: `message-delivery` task runs and injects the notification
- **Then**: The notification is injected exactly once. On the next scheduler cycle, the same message is NOT re-injected. The message remains unread in the database until the orchestrator explicitly reads it via `GET /api/messages?unread=true`.

### Scenario 3: Progress reporting chain

- **Given**: Orchestrator is working on a complex task (e.g., "spec out feature X")
- **When**: Orchestrator posts progress updates: "reading current implementation" → "spawned 2 research workers" → "worker A complete, worker B in progress" → "synthesizing results" → "spec written, sending to comms"
- **Then**: Each progress update is injected into comms session within 2 seconds. Comms relays summarized progress to the human. The human sees real-time status instead of silence.

### Scenario 4: Orchestrator asks comms a question (direct channel)

- **Given**: Orchestrator is processing a task and needs clarification
- **When**: Orchestrator sends a `type: "question"` message to comms via direct channel
- **Then**: Comms receives the question immediately (not on next heartbeat cycle), asks the human, and replies. Orchestrator receives the answer within seconds of comms posting it. Total round-trip < 30 seconds (limited by human response time, not daemon latency).

### Scenario 5: Task with worker assignment tracking

- **Given**: Orchestrator picks up a task from the queue
- **When**: Orchestrator spawns 2 workers and assigns them to the task
- **Then**: `GET /api/orchestrator/tasks/:id` shows both worker IDs, their statuses, and the task's overall status as `in_progress`. When both workers complete, task status transitions to `completed` with a result summary.

### Scenario 6: Task timeout

- **Given**: A task is assigned with a 10-minute timeout
- **When**: 10 minutes pass without the task reaching `completed` or `failed`
- **Then**: Daemon automatically transitions the task to `failed` with reason "timeout". Comms is notified.

## Technical Design

### 0. Generic Session Naming

#### Current Problem

Tmux session names are derived from the assistant's name (e.g., `bmo`, `bmo-orch`). This is BMO-specific and breaks the framework contract — kithkit should work for any assistant without code changes.

#### Fix

Standardize on role-based session names:

| Role | Session Name | Currently |
|------|-------------|-----------|
| Comms | `commsagent` | `bmo` (or config.tmux.session) |
| Orchestrator | `orchagent` | `bmo-orch` (derived) |

These are hardcoded constants, not configurable — every kithkit instance uses the same session names. This simplifies daemon code (no name derivation logic), makes scripts portable, and eliminates a class of "which session am I?" bugs.

**Files affected:**
- `daemon/src/agents/tmux.ts` — `configureTmux()`, `resolveSession()`, `spawnOrchestratorSession()`
- `daemon/src/automation/tasks/comms-heartbeat.ts` — session detection
- `daemon/src/automation/tasks/orchestrator-idle.ts` — session detection
- `kithkit.config.yaml` — remove `tmux.session` config option (no longer needed)
- `.claude/hooks/` — any hooks that reference session names

#### Timer Agent Routing

The timer API (`POST /api/timer`) currently defaults to injecting into the comms session. With generic session names, add an explicit `agent` field:

```json
{ "delay": "90s", "message": "check worker results", "agent": "orchestrator" }
```

The daemon resolves `agent` → session name via the same `resolveSession()` mapping. Default remains `comms` for backward compatibility.

**Files affected:**
- `daemon/src/api/timer.ts` — accept `agent` field, resolve to session name
- `daemon/src/db/schema.ts` — `timers.session` column already exists, ensure it stores the role name (not tmux session name) so resolution is consistent

### 1. Task Queue

#### Schema: `orchestrator_tasks`

```sql
CREATE TABLE orchestrator_tasks (
  id TEXT PRIMARY KEY,              -- UUID
  title TEXT NOT NULL,              -- Short description for display
  description TEXT,                 -- Full task prompt/context
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|assigned|in_progress|completed|failed
  assignee TEXT,                    -- Who owns it: null (unowned), 'orchestrator', or worker UUID
  priority INTEGER NOT NULL DEFAULT 0,     -- 0=normal, 1=high, 2=urgent
  result TEXT,                      -- Final result (set on completion)
  error TEXT,                       -- Error message (set on failure)
  timeout_seconds INTEGER,          -- Optional per-task timeout
  -- parent_task_id deferred to v2 (subtask decomposition)
  created_at TEXT NOT NULL,
  assigned_at TEXT,                 -- When someone claimed the task
  started_at TEXT,                  -- When work began
  completed_at TEXT,                -- When terminal state reached
  updated_at TEXT NOT NULL
);
```

#### Schema: `orchestrator_task_workers`

```sql
CREATE TABLE orchestrator_task_workers (
  task_id TEXT NOT NULL REFERENCES orchestrator_tasks(id),
  worker_id TEXT NOT NULL,          -- UUID from worker_jobs
  role TEXT,                        -- Optional: "research", "coding", "testing"
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_id, worker_id)
);
```

#### Schema: `orchestrator_task_activity`

Activity log per task — captures both structured progress updates and freeform agent notes. Like comments on a GitHub issue, but for task execution.

```sql
CREATE TABLE orchestrator_task_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES orchestrator_tasks(id),
  agent TEXT NOT NULL,              -- Who wrote it: 'orchestrator', 'comms', or worker UUID
  type TEXT NOT NULL DEFAULT 'note', -- 'progress' | 'note'
  stage TEXT,                       -- For type='progress': e.g., "spawning_workers", "synthesizing"
  message TEXT NOT NULL,            -- Human-readable message
  created_at TEXT NOT NULL
);
```

Examples:
- `(note, orch)` "Assigning to research worker. This depends on API reference being current."
- `(progress, orch)` stage=spawning_workers, "Spawned 2 research workers"
- `(note, worker-abc)` "Found 5 relevant files in daemon/src/api/"
- `(progress, orch)` stage=synthesizing, "All workers done, writing results"
- `(note, orch)` "Completed — added new spec to projects/orchestrator-v2/"

#### API Endpoints

**`POST /api/orchestrator/tasks`** — Create a task
```json
// Request
{ "title": "Spec out orchestrator v2", "description": "Full task prompt...", "priority": 1, "timeout_seconds": 600 }
// Response
{ "id": "uuid", "status": "pending", "created_at": "..." }
```

**`GET /api/orchestrator/tasks`** — List tasks
```
GET /api/orchestrator/tasks?status=in_progress
GET /api/orchestrator/tasks?status=pending,assigned
```
Returns tasks with their worker assignments and latest progress entry.

**`GET /api/orchestrator/tasks/:id`** — Get task detail
Returns task + all workers + full progress history.

**`PUT /api/orchestrator/tasks/:id`** — Update task
```json
// Orchestrator claims a task
{ "status": "assigned", "assignee": "orchestrator" }
// Orchestrator hands it to a worker
{ "assignee": "worker-uuid-123" }
// Worker starts work
{ "status": "in_progress" }
// Task completes
{ "status": "completed", "result": "..." }
// Task fails
{ "status": "failed", "error": "..." }
```

#### State Flow

```
pending ──→ assigned ──→ in_progress ──→ completed
               │              │
               │              └──→ failed
               └──→ failed (can't be done)

assignee transitions (independent of status):
  null → orchestrator → worker-uuid
  null → orchestrator (orch does it directly)
```

#### Valid Status/Assignee Combinations

The API enforces these combinations — invalid pairs return 400:

| Status | Assignee | Meaning |
|--------|----------|---------|
| `pending` | `null` | In queue, nobody has touched it |
| `assigned` | `orchestrator` | Orch claimed it, evaluating approach |
| `assigned` | worker UUID | Orch handed to worker, worker hasn't started |
| `in_progress` | `orchestrator` | Orch doing the work directly |
| `in_progress` | worker UUID | Worker is actively executing |
| `completed` | any | Terminal — result is set |
| `failed` | any | Terminal — error is set |

**Drift rule**: Setting `assignee` without `status` does NOT auto-advance status. Setting `status` to `assigned` requires `assignee` to be non-null. Setting `status` to `pending` clears `assignee` to null (task returned to queue). Both fields can be set in the same PUT request.

**`GET /api/orchestrator/tasks/:id/activity`** — Get activity log for a task
```
GET /api/orchestrator/tasks/:id/activity?limit=50&offset=0
```
Returns activity entries ordered by `created_at ASC`. Supports pagination via `limit` (default 50, max 200) and `offset` (default 0). Response includes `total` count for UI paging.

**`POST /api/orchestrator/tasks/:id/activity`** — Post activity entry (progress or note)
```json
// Structured progress update
{ "type": "progress", "stage": "spawning_workers", "message": "Spawned 2 research workers for codebase analysis" }
// Freeform note
{ "type": "note", "message": "This task depends on the API reference being up to date" }
```
Daemon inserts into `orchestrator_task_activity` (with `agent` set from request context). For type='progress', immediately injects into comms session.

**`POST /api/orchestrator/tasks/:id/workers`** — Assign worker to task
```json
{ "worker_id": "uuid", "role": "research" }
```

#### Escalation Integration

`POST /api/orchestrator/escalate` changes from message-only to task-backed:

```
Current flow:
  escalate → sendMessage(type:task) → spawn orchestrator → notify

New flow:
  escalate → INSERT orchestrator_tasks → spawn orchestrator (if dead) → notify once
```

The orchestrator prompt is updated to pull tasks from `GET /api/orchestrator/tasks?status=pending` instead of reading messages of `type: task`.

### 2. Deliver-Once Notifications

#### Current Problem

Two overlapping loops:

1. **`message-delivery` Phase 2** (`repingUnreadMessages`): Queries all unread messages, re-pings every 60 seconds per message. No maximum ping count.
2. **`comms-heartbeat`**: Independently queries unread messages for comms, nudges every 60 seconds. No coordination with Phase 2.

Result: An unread message gets pinged every ~30 seconds (two offset 60-second cycles), indefinitely.

#### Fix

**Remove `repingUnreadMessages` entirely.** Phase 2 of `message-delivery` is deleted.

**Modify Phase 1 (`deliverNewMessages`)**: When a message is first processed, inject the notification and set `processed_at`. This is the one and only notification for that message. If injection fails (agent session not live), retry up to `MAX_RETRIES` (existing behavior) — but once `processed_at` is set, never re-notify.

**Modify `comms-heartbeat`**: Remove the unread message count query and nudge. The heartbeat's only job becomes notifying about unacknowledged worker completions (which already has its own acknowledgment mechanism via `acknowledged_at`).

**Net result**: One notification per message, delivered on first successful injection. If the agent was dead for all retry attempts, the message remains in the DB — the agent will see it on next `GET /api/messages?unread=true`. No nagging.

#### Fallback Safety

Concern: what if a message is processed, notified once, but the agent genuinely missed it?

Mitigation: The agent's own polling behavior (orchestrator wrapper polls `?since_id=N` every 10 seconds, comms reads messages when prompted) is sufficient. The agent is responsible for reading its own messages. The daemon's job is to deliver the notification once, not to babysit.

If stronger guarantees are needed later, a `GET /api/messages/unread-summary` endpoint can return counts without triggering re-notification — agents can poll this on their own schedule.

### 3. Agent-to-Agent Direct Channel

#### Design

A lightweight synchronous request/reply mechanism that bypasses the scheduler-tick delivery pipeline.

**Mechanism**: When agent A sends a message with `"direct": true`, the daemon immediately injects it into agent B's tmux session (if alive) in the same HTTP request handler — no waiting for the scheduler. The message is still stored in the `messages` table for auditability.

#### API

Uses the existing `POST /api/messages` endpoint with a new flag:

```json
{
  "from": "orchestrator",
  "to": "comms",
  "type": "question",
  "body": "The spec references issue #24 — should I include the GitHub issue comments in the background section?",
  "direct": true
}
```

#### Implementation

In `message-router.ts`, after `sendMessage` inserts the row, check `direct === true`:
- If true and target agent is a persistent agent (comms or orchestrator) with a live tmux session: inject immediately via `injectMessage`, set `processed_at`.
- If target is not live: fall through to normal delivery (Phase 1 on next tick).

This is a ~10-line change to the existing `sendMessage` function. No new transport, no WebSockets, no polling changes. The key insight is that the latency problem is the scheduler tick, not the delivery mechanism — bypassing the scheduler for flagged messages solves it.

### 4. Progress Reporting

#### Orchestrator → Comms

The orchestrator posts activity via `POST /api/orchestrator/tasks/:id/activity`. The daemon:

1. Inserts the record into `orchestrator_task_activity`
2. For type='progress', if comms is alive, immediately injects a formatted notification:
   ```
   [task <title>] <stage>: <message>
   ```
3. Sets a `notified_at` on the progress record (deliver-once, same pattern)

#### Workers → Orchestrator

Workers already send `type: result` messages on completion. For mid-task progress, workers can use `POST /api/messages`:

```json
{
  "from": "worker-uuid",
  "to": "orchestrator",
  "type": "progress",
  "body": "Finished reading 5 files, found 3 relevant sections",
  "direct": true
}
```

The orchestrator summarizes worker progress and posts a higher-level update to its own task's progress log.

#### Summarization Chain

```
Worker: "Read 847 lines across 5 files in daemon/src/api/"
    ↓ orchestrator summarizes
Orchestrator → Comms: "Research worker finished codebase analysis (5 files)"
    ↓ comms summarizes
Comms → Human: "The orchestrator is making progress — research phase done, moving to writing."
```

Each layer reduces detail for the one above. Workers are verbose, orchestrator is structured, comms is conversational.

## Delivery Phases

This spec ships in 3 phases to reduce risk and unblock the flooding fix quickly:

**Phase 1: Generic Session Names** (foundation)
- Hardcode `commsagent`/`orchagent` tmux session names
- Add `agent` field to timer API
- Remove `tmux.session` config option
- *Status: implementation complete, pending commit*

**Phase 2: Deliver-Once Notifications** (outage fix)
- Delete `repingUnreadMessages` (Phase 2 of message-delivery)
- Remove unread message nudging from comms-heartbeat
- *This is the actual fix for the 3/6 orchestrator spawn failures*

**Phase 3: Task Queue + Direct Channel + Activity Log**
- New tables: `orchestrator_tasks`, `orchestrator_task_workers`, `orchestrator_task_activity`
- New API endpoints for task CRUD and activity
- `direct: true` flag on messages API
- Update orchestrator prompt to use task queue
- Progress forwarding to comms

## Migration

New tables are added via a new migration file (next sequential number). No existing tables are modified except:

- `messages.metadata` may gain a `direct` flag (informational only, not used for delivery logic — the `direct` flag is on the API request, not stored)
- No schema changes to `messages`, `agents`, or `worker_jobs`

The migration is purely additive — zero risk to existing data.

## Documentation Impact

- [ ] `CLAUDE.md` — update orchestrator section to reference task queue API
- [ ] `docs/api-reference.md` — add task queue endpoints
- [ ] Orchestrator prompt (`buildOrchestratorPrompt`) — update to use task queue instead of message-based task discovery

## Open Questions

- [ ] Should failed tasks be retryable? (e.g., `POST /api/orchestrator/tasks/:id/retry` resets to `pending`) — leaning yes but could defer to v2
- [ ] Should task timeout enforcement be a scheduler task or a per-task timer? Scheduler task (polling every 30s) is simpler; per-task timer is more precise but adds complexity.
- [ ] For the direct channel: should there be a rate limit to prevent message storms? The current 5-second dedup window on `sendMessage` may be sufficient.
- [ ] Should `commsagent`/`orchagent` be the exact session names, or something shorter like `comms`/`orch`? Shorter is nicer for `tmux` commands but might collide with user sessions.
