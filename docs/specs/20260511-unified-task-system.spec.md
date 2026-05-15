# Unified Task System — Specification

**Date:** 2026-05-11
**Version:** v1.5
**Status:** Draft (patch pass — ready for peer review)
**Author:** Worker (spec pass)

> v1.5 changelog (2026-05-11): Added empirical time tracking, scheduling (recurring tasks), dependency edges, complexity+risk dimensions, retry-reasons enum, per-task notification policy, cross-agent subscriptions, reasoning trail (memory_ids + linked_artifacts), parent-status cascade rules. Renamed outcome values (success→succeeded, unknown→abandoned) and outcome_notes→outcome_reason. See `## Changelog` at end of doc for full delta.

---

## 1. Goals and Non-Goals

### Goals

- **Single source of truth.** Merge `todos` and `orchestrator_tasks` into one `tasks` table that covers human-owned todos, agent-owned work items, and coworked items shared between both.
- **Unified status lifecycle.** Define a single status enum and state machine that maps cleanly onto both the existing todos workflow and the orchestrator task workflow, without losing any current semantics.
- **Preserved plan-approval workflow.** The plan/plan_status/plan_submitted_at/plan_approved_at/plan_rejected_reason fields must survive the migration intact and continue to drive the plan-approval loop.
- **Coworking semantics.** Support tasks that are assigned to a human, an agent, or neither, and allow both humans and agents to act on the same task without ownership conflicts.
- **Parent/child relationships.** Allow orchestrator-decomposed subtasks to point at a parent task, enabling rollup queries and progress tracking without a separate join table.
- **Backwards-compatible API surface for one release cycle.** Existing callers of `/api/todos` and `/api/orchestrator/tasks` must continue to work without modification during the transition.
- **Fix silent schema bugs.** Resolve the ghost `source` column (API uses it, schema doesn't have it) and the undeclared `done` status alias.

### Non-Goals

- **Sprint-currency story points, sprints, milestones, swimlanes.** This is an agent-first task store, not a project management suite. `complexity` (1-5) and `risk` (1-5) are in scope as lightweight task attributes; Fibonacci-scaled sprint points, burndown charts, and velocity tracking are not.
- **Hard authorization enforcement.** The daemon is localhost-only with no auth; ownership rules are convention, not gatekeeping.
- **External sync.** No GitHub Issues, Linear, or Jira integration. Tasks live in the daemon's SQLite DB.
- **Real-time collaborative editing.** Concurrent writes on the same row are last-write-wins; no CRDT or locking.
- **Two tables or namespace-by-actor.** A single table is the requirement; do not revisit this.
- **User-facing snooze UI.** Migration 019 (snooze_until) was not applied to the live DB and remains out of scope. System-level scheduling (recurring tasks, `schedule_cron`, `next_fire_at`) is in scope; a dedicated human-facing snooze interaction is not.

---

## 2. Constraints

> **Dave, verbatim, on human+agent coworking (constraint A):**
>
> "We don't leverage todos today just for tasks assigned to the agent, but for its human too. BMO tracks my todos alongside his own and we cowork on some of them, it's worked well. We could track them separately, but that seems redundant to me."

> **Dave, verbatim, on agent-first design (constraint B):**
>
> "This task system is built for agents... meaning we don't need to mirror everything that humans might expect from a task tracking system. Our primary users will be agents and we should design it for them."

These two constraints together define the design envelope: one table, no human/agent namespacing, but the schema should be optimized for agent query patterns (status filters, assignee filters, parent-child traversal) rather than for human UX concerns (rich metadata, attachments, comments threads, etc.).

---

## 3. Unified Table Schema

### Primary table: `tasks`

```sql
CREATE TABLE IF NOT EXISTS tasks (
  -- Identity
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE,          -- Preserves UUID from migrated orchestrator_tasks rows.
                                    -- New tasks: NULL. API accepts both integer and UUID in path params.

  -- Core
  title       TEXT NOT NULL,
  description TEXT,

  -- Classification
  category    TEXT,                 -- Freeform. Suggested values: maintenance, feature, bug, research, chore, conversation
  source      TEXT,                 -- Origin of the task: telegram, orchestrator, human, api, scheduler
  tags        JSON NOT NULL DEFAULT '[]',
  parent_id   INTEGER REFERENCES tasks(id) ON DELETE SET NULL,

  -- Assignment
  assigned_to TEXT,                 -- Agent ID (e.g. "orchestrator", "worker-abc"), actor name ("dave"), or NULL (unassigned).

  -- Priority (TEXT, unified)
  priority    TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high | urgent

  -- Status
  status      TEXT NOT NULL DEFAULT 'pending',  -- See §4 for full enum and transitions.

  -- Scheduling
  due_date    TEXT,                 -- ISO-8601 date string or datetime.

  -- Plan-approval workflow (preserved from orchestrator_tasks migration 018)
  plan                  TEXT,       -- Full plan text submitted for approval.
  plan_status           TEXT,       -- NULL | submitted | approved | rejected
  plan_submitted_at     TEXT,       -- datetime when plan was submitted.
  plan_approved_at      TEXT,       -- datetime when plan was approved.
  plan_rejected_reason  TEXT,       -- Human-readable rejection note.

  -- Execution tracking (preserved from orchestrator_tasks)
  result          TEXT,             -- Freeform result/output on completion.
  error           TEXT,             -- Error message on failure.
  work_notes      TEXT,             -- Freeform notes written during execution.
  retry_count     INTEGER NOT NULL DEFAULT 0,
  timeout_seconds INTEGER,          -- NULL = no timeout.
  outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded','partial','failed','abandoned')),
  outcome_reason  TEXT,             -- Explanation of outcome.

  -- Empirical time tracking (v1.5)
  estimated_minutes  INTEGER,
  actual_minutes     INTEGER,
  calibration_mult   REAL,
  -- Scheduled execution (v1.5)
  schedule_cron              TEXT,
  schedule_interval_seconds  INTEGER,
  next_fire_at               TIMESTAMP,
  is_recurring_parent        BOOLEAN NOT NULL DEFAULT 0,
  parent_recurring_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  -- Complexity + risk dimensions (v1.5, separate from priority and time)
  complexity INTEGER CHECK (complexity IS NULL OR complexity BETWEEN 1 AND 5),
  risk       INTEGER CHECK (risk IS NULL OR risk BETWEEN 1 AND 5),
  -- Retry reasons (v1.5)
  last_retry_reason TEXT CHECK (last_retry_reason IS NULL OR last_retry_reason IN
    ('timeout','worker_error','cancelled','transient_failure','plan_rejected','peer_unreachable')),
  -- Notification policy (v1.5)
  notify_policy JSON,  -- {when_to_nudge, when_to_escalate, who_to_notify_on_change[]}
  -- Cross-agent subscriptions (v1.5)
  subscribed_agents JSON NOT NULL DEFAULT '[]',
  -- Reasoning trail (v1.5)
  memory_ids        JSON NOT NULL DEFAULT '[]',
  linked_artifacts  JSON NOT NULL DEFAULT '[]',

  -- Timestamps
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at   TEXT,               -- Set when status → assigned.
  started_at    TEXT,               -- Set when status → in_progress (first time).
  completed_at  TEXT                -- Set when status → completed | failed | abandoned | cancelled.
);
```

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_status       ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to  ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_priority     ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id    ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at   ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_external_id  ON tasks(external_id);  -- for UUID lookups from legacy callers
CREATE INDEX IF NOT EXISTS idx_tasks_source       ON tasks(source);
```

### Companion tables (retained, updated FKs)

**`task_actions`** (renamed from `todo_actions`, same schema, FK updated):
```sql
CREATE TABLE IF NOT EXISTS task_actions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action   TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  note     TEXT,
  actor    TEXT,                    -- NEW: agent or human who performed the action. NULL = unknown.
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_actions_task_id ON task_actions(task_id);
```

**`task_workers`** (renamed from `orchestrator_task_workers`):
During migration, `task_id` references are updated from orchestrator UUID → new integer ID.
```sql
CREATE TABLE IF NOT EXISTS task_workers (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id   TEXT NOT NULL,
  role        TEXT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_id, worker_id)
);
```

**`task_activity`** (renamed from `orchestrator_task_activity`):
```sql
CREATE TABLE IF NOT EXISTS task_activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent    TEXT NOT NULL,
  type     TEXT NOT NULL DEFAULT 'note',
  stage    TEXT,
  message  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_activity_task_id ON task_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_task_activity_type    ON task_activity(type);
```

> Note on FK cascades: `orchestrator_task_workers` and `orchestrator_task_activity` currently have no cascade. This was intentional (preserving activity history after deletion). The unified schema adds `ON DELETE CASCADE` to all companion tables because orphaned rows are hard to audit and the activity log is already append-only. If activity preservation on delete is needed in future, use soft-deletes on tasks instead of hard DELETE.

**`task_deps`** (new in v1.5 — lateral dependency edges):
```sql
-- Lateral dependency edges (v1.5). parent_id on tasks remains the hierarchy edge.
CREATE TABLE task_deps (
  id           TEXT PRIMARY KEY,
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  edge_type    TEXT NOT NULL CHECK (edge_type IN ('blocks','relates_to')),
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (from_task_id, to_task_id, edge_type)
);
```

**`task_calibration`** (new in v1.5 — rolling per-agent estimate calibration):
```sql
-- Rolling per-(agent, category) calibration of estimate vs. actual (v1.5).
CREATE TABLE task_calibration (
  id                TEXT PRIMARY KEY,
  agent_name        TEXT NOT NULL,
  category          TEXT,  -- profile/tag bucket; NULL means agent-global
  window_started_at TIMESTAMP NOT NULL,
  sample_count      INTEGER NOT NULL,
  mean_ratio        REAL NOT NULL,  -- mean(actual_minutes / estimated_minutes)
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_name, category)
);
```

### Priority normalization

`todos.priority` is TEXT (`low | medium | high | urgent`).
`orchestrator_tasks.priority` is INTEGER (`0` = default, higher = more urgent).

**Resolution:** Unified table uses TEXT. Migration maps integer values:

| orchestrator_tasks.priority | tasks.priority |
|-----------------------------|----------------|
| 0 (default)                 | medium         |
| 1                           | low            |
| 2                           | medium         |
| 3                           | high           |
| ≥ 4                         | urgent         |

Orchestrator code that writes integer priorities is updated in S2 (API consolidation story) to use the TEXT enum.

### 3.A — Empirical time tracking & calibration

Agents estimate `estimated_minutes` at task creation. On completion, `actual_minutes` is recorded. The daemon updates a rolling per-(agent, category) record in `task_calibration` (mean ratio of actual/estimated over the last N completions, default N=20). When a new task is scheduled, the daemon may set `calibration_mult` from the matching calibration row so downstream consumers can render adjusted estimates without recomputing. Calibration is advisory; it does not change task deadlines.

### 3.B — Scheduled and recurring tasks

Recurring tasks are modeled as a parent template (`is_recurring_parent = 1`) plus transient child instances. The scheduler fires at `next_fire_at` (computed from `schedule_cron` or `schedule_interval_seconds`), creates a child task with `parent_recurring_id` set to the template, and bumps the template's `next_fire_at`. Children are full first-class tasks (own status, retries, outcome). Templates themselves are never executed — they hold the schedule. Disabling a recurring task means setting `is_recurring_parent = 0` or clearing the schedule fields; existing children continue independently.

### 3.C — Dependency edges

`parent_id` on `tasks` models the hierarchy (subtask of). The `task_deps` table models lateral edges:
- `blocks` — from-task must reach a terminal outcome before to-task can leave `pending`/`blocked`.
- `relates_to` — soft 'see also' link; informational, no enforcement.

`blocked_by` is implied by reversing a `blocks` edge — not stored separately. A task whose unresolved blockers is non-empty is auto-set to status `blocked` by the daemon.

### 3.D — Notification policy

`notify_policy` JSON shape:
```json
{
  "when_to_nudge":   "<iso8601 | rule expression>",
  "when_to_escalate":"<iso8601 | rule expression>",
  "who_to_notify_on_change": ["agent_name", ...]
}
```
Rule expressions are a small DSL (TBD): e.g. `"overdue+15m"`, `"blocked>1h"`. Implementation deferred; spec defines the field shape only.

### 3.E — Cross-agent subscriptions

`subscribed_agents` is a JSON array of agent names. On any state-changing update to the task, the daemon emits a notification to each subscribed agent via the standard inter-agent message channel. The task creator is implicitly subscribed; additional subscribers are added via task update. Subscriptions are independent of `notify_policy.who_to_notify_on_change` — the former tracks change events; the latter is reserved for specific change triggers (e.g. only on completion).

### 3.F — Reasoning trail

`memory_ids` is a JSON array of memory record IDs that informed the task (e.g. relevant past decisions, retro entries). `linked_artifacts` is a JSON array of `{kind, path_or_id, note}` objects pointing to PRs, spec files, code paths, etc. Together with the narrative `task_activity` log, these provide a structured trace from inputs through execution to outputs.

---

## 4. State Machine

### Status enum (11 values)

```
proposed | pending | assigned | planning | awaiting_approval |
in_progress | blocked | completed | failed | abandoned | cancelled
```

Three values are **new** relative to the union of both existing enums: `proposed`, `planning`, `abandoned`.

`done` (undeclared alias in todos API) maps to `completed` at migration time and is rejected thereafter. `assigned` (orchestrator-only) and `awaiting_approval` (orchestrator-only) are elevated to the shared enum.

### ASCII state diagram

```
      ┌──────────┐
      │ proposed │  ←── External suggestion, not yet queued
      └────┬─────┘
           │ accept              cancelled ◄──────────────────────────┐
           ▼                                                          │
      ┌─────────┐                                                     │
      │ pending │  ←── Queued, not yet assigned  ─────────────────────┤
      └────┬────┘                                                     │
           │ assign                                                   │
           ▼                                                          │
      ┌──────────┐                                                    │
      │ assigned │  ─────────────────────────────────────────────────►┘
      └────┬─────┘
           │
     ┌─────┴──────────────────┐
     │                        │
     ▼                        ▼
┌──────────┐           ┌─────────────┐
│ planning │           │ in_progress │ ◄─────────────────────────┐
└────┬─────┘           └──────┬──────┘                           │
     │                        │                                  │
     ▼                        │ block                            │
┌──────────────────┐          ▼                       unblock    │
│awaiting_approval │     ┌─────────┐ ──────────────────────────►─┤
└────────┬─────────┘     │ blocked │                             │
         │               └────┬────┘                             │
    ┌────┴────┐                │ abandon                         │
    │approved │                ▼                                 │
    └────┬────┘          ┌──────────┐                            │
         │               │ abandoned│                            │
         └───────────────►──────────┘                           │
         (start work)                                            │
                         ┌───────────┐                          │
    in_progress ─────────► completed │                          │
    in_progress ─────────► failed    │──── retry ───────────────┘
    in_progress ─────────► abandoned │
```

### Transition rules

| From               | To                    | Trigger                                              | Side effects                              |
|--------------------|-----------------------|------------------------------------------------------|-------------------------------------------|
| proposed           | pending               | Human or agent accepts the task                      | —                                         |
| proposed           | cancelled             | Explicitly rejected before acceptance                | completed_at = now                        |
| pending            | assigned              | Orchestrator or human assigns an actor               | assigned_at = now                         |
| pending            | cancelled             | Withdrawn before assignment                          | completed_at = now                        |
| assigned           | planning              | Orchestrator begins writing a plan                   | —                                         |
| assigned           | in_progress           | Work starts without a formal plan                    | started_at = now (if null)                |
| assigned           | cancelled             | Withdrawn after assignment                           | completed_at = now                        |
| planning           | awaiting_approval     | Plan submitted (plan_status = submitted)             | plan_submitted_at = now                   |
| planning           | in_progress           | Plan auto-approved or approval bypassed              | started_at = now (if null)                |
| awaiting_approval  | in_progress           | Plan approved (plan_status = approved)               | plan_approved_at = now, started_at = now  |
| awaiting_approval  | planning              | Plan rejected, must re-plan (plan_status = rejected) | plan_rejected_reason set                  |
| awaiting_approval  | abandoned             | Plan rejected and task dropped                       | completed_at = now                        |
| in_progress        | blocked               | Dependency or blocker identified                     | —                                         |
| in_progress        | completed             | Work finished successfully                           | completed_at = now, outcome set           |
| in_progress        | failed                | Technical failure                                    | completed_at = now, error set             |
| in_progress        | abandoned             | Dropped mid-execution (not a failure, not complete)  | completed_at = now                        |
| blocked            | in_progress           | Blocker resolved                                     | —                                         |
| blocked            | failed                | Timeout while blocked                                | completed_at = now                        |
| blocked            | abandoned             | Permanently blocked, task dropped                    | completed_at = now                        |
| failed             | pending               | Retry requested (retry_count incremented)            | retry_count += 1                          |

**Terminal states:** `completed`, `abandoned`, `cancelled`, and `failed` with `retry_count >= max_retries`.
No transitions are allowed out of terminal states except `failed → pending` (explicit retry).

**Pre-existing break:** `blocked` did not exist as a valid status in `orchestrator_tasks`. Tasks currently in the orchestrator system that are "waiting" are either `in_progress` (with a blocked note in work_notes) or `assigned`. The migration maps these as-is — no synthetic state upgrade. Teams relying on work_notes to signal blocking should migrate to the `blocked` status going forward.

### 4.A — Parent status cascade rules

These are application-layer behaviors, not FK constraints:
- **Parent → `completed`:** children with status `pending`/`blocked` are left as-is. The assignee should review whether they still have value. The system does not auto-cancel them.
- **Parent → `failed`:** children remain as-is. The assignee decides whether to retry, abandon, or detach.
- **Parent → `abandoned`:** children with status `pending`/`blocked` are auto-set to `abandoned` with `outcome_reason = 'parent_abandoned'`. In-progress children (`in_progress`, `awaiting_approval`) continue running — don't kill live work. On their completion they are flagged in `task_activity` but their outcome is preserved as-is.
- **Recurring parent** (`is_recurring_parent = 1`) status changes affect future child instances only; past children are immutable history.

---

## 5. New Metadata Columns — Field Semantics

### `assigned_to` (TEXT, nullable)

**Purpose:** Identifies who (or what) is responsible for driving the task to completion. Replaces `orchestrator_tasks.assignee` and adds a slot for human actors previously missing from both tables.

**Type:** Free-form TEXT. No FK constraint — valid values include agent IDs (`orchestrator`, `worker-abc123`), human actor names (`dave`), and role labels (`human`). NULL means unassigned.

**Examples:**
- `assigned_to = NULL` — backlog item, nobody owns it yet
- `assigned_to = 'orchestrator'` — orchestrator is running the task
- `assigned_to = 'dave'` — Dave's personal todo
- `assigned_to = 'worker-f4b8'` — specific ephemeral worker

**Queryability:**
- `WHERE assigned_to = 'dave'` — Dave's task list
- `WHERE assigned_to IS NULL AND status = 'pending'` — unassigned backlog
- `WHERE assigned_to != 'dave' AND status = 'in_progress'` — all active agent tasks

### `source` (TEXT, nullable)

**Purpose:** Records where the task originated. Fixes the ghost column (API wrote/read it, schema never stored it). Enables routing logic and audit filtering.

**Type:** Free-form TEXT. Suggested values: `telegram`, `orchestrator`, `human`, `api`, `scheduler`, `a2a`. No enforcement at DB level.

**Examples:**
- `source = 'telegram'` — BMO received this as a Telegram message from Dave
- `source = 'orchestrator'` — spawned as a subtask by the orchestrator
- `source = 'scheduler'` — generated by a scheduled cron task

**Queryability:**
- `WHERE source = 'telegram' AND status != 'completed'` — pending work that came from Dave via Telegram
- `WHERE source = 'orchestrator' AND parent_id IS NOT NULL` — all orchestrator subtasks

### `category` (TEXT, nullable)

**Purpose:** High-level task taxonomy. Enables filtering by work type without parsing titles or tags.

**Type:** Free-form TEXT. Suggested values: `maintenance`, `feature`, `bug`, `research`, `chore`, `conversation`, `reminder`. No enforcement at DB level; agents may introduce new values.

**Examples:**
- `category = 'bug'` — something broken that needs fixing
- `category = 'research'` — investigation task, output is information not code
- `category = 'chore'` — routine maintenance (log rotation, DB cleanup)

**Queryability:**
- `WHERE category = 'research' AND status = 'in_progress'` — active research tasks
- `WHERE category NOT IN ('conversation', 'reminder') AND status = 'pending'` — real work backlog

### `parent_id` (INTEGER, nullable, FK → tasks.id ON DELETE SET NULL)

**Purpose:** Enables orchestrator-style task decomposition within a single table. A parent task can have N child tasks; children point up to their parent. Grandchild nesting is allowed but not recommended (flat two-level hierarchy is sufficient for current use).

**Type:** INTEGER FK referencing `tasks.id`. ON DELETE SET NULL — if the parent is deleted, children become orphans rather than cascade-deleting (preserving work history).

**Examples:**
- Orchestrator creates a top-level task `id=100, title="Ship feature X"`, then creates subtasks with `parent_id=100`
- A human todo `id=5, title="Review PRs"` spawns an agent subtask `parent_id=5, title="Fetch open PR list", assigned_to='orchestrator'`

**Queryability:**
- `WHERE parent_id IS NULL` — top-level tasks only
- `WHERE parent_id = 100` — immediate children of task 100
- `WHERE parent_id IS NULL AND status NOT IN ('completed','abandoned','cancelled')` — active top-level work

---

## 6. View / Filter Patterns

Concrete SQL examples for common query shapes. These are documentation; the API layer implements them as parameterized queries.

```sql
-- "My commitments" (tasks Dave is responsible for, not done)
SELECT * FROM tasks
WHERE assigned_to = 'dave'
  AND status NOT IN ('completed', 'abandoned', 'cancelled')
ORDER BY priority DESC, created_at ASC;

-- "Agent queue" (pending work for the orchestrator or any worker, high-priority first)
SELECT * FROM tasks
WHERE assigned_to != 'dave'          -- or: assigned_to NOT IN ('dave', ...)
  AND status IN ('pending', 'assigned', 'in_progress')
ORDER BY
  CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
  created_at ASC;

-- "Backlog" (unassigned pending tasks, agent or human can pick up)
SELECT * FROM tasks
WHERE assigned_to IS NULL
  AND status = 'pending'
ORDER BY
  CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
  created_at ASC;

-- "Blocked work" (anything stuck, regardless of owner)
SELECT * FROM tasks
WHERE status = 'blocked'
ORDER BY updated_at ASC;

-- "Awaiting my approval" (plan submitted, waiting for Dave)
SELECT * FROM tasks
WHERE status = 'awaiting_approval'
  AND plan_status = 'submitted'
ORDER BY plan_submitted_at ASC;

-- "Active subtasks for a parent"
SELECT * FROM tasks
WHERE parent_id = :parent_id
  AND status NOT IN ('completed', 'abandoned', 'cancelled')
ORDER BY created_at ASC;

-- "Recently completed" (last 7 days)
SELECT * FROM tasks
WHERE status IN ('completed', 'failed', 'abandoned')
  AND completed_at >= datetime('now', '-7 days')
ORDER BY completed_at DESC;

-- "Cowork view" (tasks where both human and agent are involved)
-- (approximate: tasks with both a human source and an agent assignee, or vice versa)
SELECT t.*, COUNT(ta.id) AS activity_count
FROM tasks t
LEFT JOIN task_activity ta ON ta.task_id = t.id
WHERE t.source IN ('telegram', 'human')
  AND t.assigned_to NOT IN ('dave')
  AND t.assigned_to IS NOT NULL
GROUP BY t.id
ORDER BY t.updated_at DESC;
```

---

## 7. API Impact

### Recommendation: Preserve split surface, add unified endpoint, deprecate splits in v-next

**Rationale:** The two existing API surfaces have different implicit contracts. `/api/todos` consumers (human-facing, 2 test files) expect integer IDs and a minimal field set. `/api/orchestrator/tasks` consumers (5 code files including core orchestrator logic) expect UUID-style IDs in `external_id`, plan-approval endpoints, and activity/workers sub-routes. Unifying the surface in one release risks breaking both consumer groups. The safer path: route both old surfaces through the unified `tasks` table immediately, add `/api/tasks` as the canonical new endpoint, and deprecate the split surfaces in a subsequent release.

### Endpoint-by-endpoint changes

#### `/api/todos` — preserved, deprecation notice added

| Method | Path | Change |
|--------|------|--------|
| GET | `/api/todos` | Reads from `tasks WHERE source != 'orchestrator' OR assigned_to = 'dave'`. Actually simpler: no implicit filter — returns all tasks. Status `done` is normalized to `completed` in response for backwards compat. |
| POST | `/api/todos` | Inserts into `tasks`. `source` field now persisted (fixes ghost column). `done` rejected; use `completed`. |
| GET | `/api/todos/:id` | Accepts integer ID. Returns task row. |
| PUT | `/api/todos/:id` | Updates task. Status `done` → `completed` translation applied. |
| DELETE | `/api/todos/:id` | Deletes from `tasks`. Cascades to `task_actions`. |
| GET | `/api/todos/:id/actions` | Reads from `task_actions WHERE task_id = :id`. |

#### `/api/orchestrator/tasks` — preserved, deprecation notice added

| Method | Path | Change |
|--------|------|--------|
| GET | `/api/orchestrator/tasks` | Reads from `tasks`. Filters to tasks with `source = 'orchestrator'` OR `assigned_to` matching an agent ID (not dave). Response maps `id` → integer, `external_id` → original UUID for old callers. |
| POST | `/api/orchestrator/tasks` | Inserts into `tasks` with `source = 'orchestrator'`. Generates UUID, stores in `external_id`. |
| GET | `/api/orchestrator/tasks/:id` | Accepts UUID (lookup via `external_id`) or integer `id`. |
| PUT | `/api/orchestrator/tasks/:id` | Same dual-lookup. |
| GET | `/api/orchestrator/tasks/:id/activity` | Reads from `task_activity`. |
| POST | `/api/orchestrator/tasks/:id/activity` | Inserts into `task_activity`. |
| POST | `/api/orchestrator/tasks/:id/workers` | Inserts into `task_workers`. |
| POST | `/api/orchestrator/tasks/:id/retry` | Sets `status = 'pending'`, increments `retry_count`. |
| POST | `/api/orchestrator/tasks/:id/cancel` | Sets `status = 'cancelled'`. |
| POST | `/api/orchestrator/tasks/:id/submit-plan` | Sets `plan`, `plan_status = 'submitted'`, `plan_submitted_at`, `status = 'awaiting_approval'`. |
| POST | `/api/orchestrator/tasks/:id/approve-plan` | Sets `plan_status = 'approved'`, `plan_approved_at`, `status = 'in_progress'`. |
| POST | `/api/orchestrator/tasks/:id/reject-plan` | Sets `plan_status = 'rejected'`, `plan_rejected_reason`, `status = 'planning'`. |

#### `/api/tasks` — new canonical endpoint

Full CRUD on `tasks` table with no implicit filters. Accepts both integer `id` and UUID `external_id` in path params. Response always includes both fields. Status transitions validated against the state machine (§4). All new code should use this endpoint.

Sub-routes: `/api/tasks/:id/activity`, `/api/tasks/:id/workers`, `/api/tasks/:id/actions`, `/api/tasks/:id/subtasks` (returns `WHERE parent_id = :id`), plus plan-approval sub-routes as above.

### Backwards-compatibility policy

The split endpoints (`/api/todos`, `/api/orchestrator/tasks`) are **soft-deprecated** as of the migration. They stay functional for one release cycle. They are removed in a subsequent release once all internal callers are updated to `/api/tasks`. No breaking changes are made to request or response shapes during the deprecation window.

---

## 8. Authorization / Multi-Agent Semantics

### Problem

Dave's tasks (`assigned_to = 'dave'`) need to be readable and writable by BMO (the comms agent). An agent updating a human's todo is the primary coworking pattern. There is no authentication on the daemon API (localhost-only), so enforcement is by convention, not gatekeeping.

### Rules (convention-level, not enforced by DB)

1. **Any agent may read any task.** No read restrictions.
2. **Any agent may create tasks.** Creator is not recorded unless `source` or `assigned_to` is set.
3. **Agents may update tasks they are `assigned_to`.** Preferred pattern — agents should only drive tasks they own.
4. **The comms agent (BMO) may update tasks `assigned_to = 'dave'`** for the purpose of marking them complete, adding notes, or changing status — this is the coworking contract.
5. **The orchestrator may update status and result on any task it spawned** (traceable via `task_activity` audit trail).
6. **No agent should reassign a task away from a human (`assigned_to = 'dave'`) without explicit human instruction.** Convention only.
7. **`task_actions` and `task_activity` serve as the audit trail.** The new `actor` field on `task_actions` should be set by the API layer when the calling agent is known. This is the mechanism for post-hoc accountability, not pre-emptive blocking.

### Practical implication

The API layer should accept an optional `actor` parameter on PUT/PATCH requests. When present, it is written to `task_actions.actor`. This enables queries like `SELECT * FROM task_actions WHERE actor = 'bmo' AND task_id = X` to reconstruct who changed what and when.

No other enforcement is implemented. If stricter access control becomes necessary, it should be specified in a dedicated auth spec rather than grafted onto this migration.

---

## Changelog

### v1.5 (2026-05-11) — peer-review patch pass
- Added empirical time tracking: `estimated_minutes`, `actual_minutes`, `calibration_mult` on tasks; new `task_calibration` table.
- Added scheduling fields: `schedule_cron`, `schedule_interval_seconds`, `next_fire_at`, `is_recurring_parent`, `parent_recurring_id`; documented recurring-parent / transient-child pattern.
- Added lateral dependency edges via new `task_deps` table (`blocks`, `relates_to`).
- Added `complexity` (1-5) and `risk` (1-5) as separate dimensions from priority and time.
- Added `last_retry_reason` enum on tasks.
- Added `notify_policy` JSON column for per-task notification rules.
- Added `subscribed_agents` JSON column for cross-agent change subscriptions.
- Added `memory_ids` and `linked_artifacts` JSON columns for structured reasoning trail.
- Added parent-status cascade rule subsection (§4.A).
- Renamed `outcome_notes` → `outcome_reason`; updated outcome enum to `succeeded | partial | failed | abandoned`.
- Refined §1 Non-Goals wording to scope out user-facing snooze and sprint-currency points only.

---

## Q6 — Provenance Convention (v2.1)

No schema column is added for provenance. When provenance metadata is meaningful (e.g. which
peer agent originated a cross-machine task, or which Telegram message triggered the work),
agents SHOULD write a free-form `Provenance:` section into `work_notes` at task creation.
Example: `Provenance: received via A2A from bmo@peer-host, ref telegram-msg-4721`.
This convention is sufficient for audit purposes without a structured column (YAGNI).
Structured provenance signing and cross-machine task sync are deferred to a future spec.

---

## Changelog

### v2.1 (2026-05-12) — Q1-Q6 locked decisions
- Migration 019: calibration + dual-stage closure + complexity + cross-machine ID columns.
- Q6: free-form provenance convention via `work_notes` (no schema change). See §Q6 above.
- calibration-hint.ts: HOLDING for BMO PR #257 merge.
- Q5 (timeout_seconds + pulse): DEFERRED — needs mini-spec.

### v1 (2026-05-11) — initial draft
Initial unified task system specification.
