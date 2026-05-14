---
name: task-system
description: Reference for the orchestrator task lifecycle — states, role responsibilities, comms acknowledgement, outcome semantics, revisable feedback, and retro/complexity conventions. Use when creating, completing, acking, or revising task feedback.
keywords: [task, orchestrator, lifecycle, comms_outcome, acknowledged_at, comms_corrections, retro, complexity, canonical_task_external_id, timeout_seconds]
applies-to: [comms, orchestrator, worker]
---

# Task System — Lifecycle, Roles, and Comms Feedback

Scannable reference for all agents. Read time: <2 min.

---

## 1. Lifecycle

```
                    ┌─────────────────────────────────────┐
                    │           Cancelled (side branch)    │
                    └─────────────────────────────────────┘
                                      ↑
pending → assigned → in_progress ─────┴──→ completed ──→ [Fully Closed]
                          │                  failed  ──→ [Fully Closed]
                          └──→ awaiting_approval ──→ in_progress
```

| Stage | Description |
|-------|-------------|
| **pending** | Task created, not yet assigned |
| **assigned** | Orch claimed it, not started |
| **in_progress** | Work underway |
| **awaiting_approval** | Plan submitted, blocked on human approval |
| **completed / failed / cancelled** | Terminal — `completed_at` set |
| **Done-internally** | Terminal status set, `acknowledged_at` NULL — comms hasn't reviewed yet |
| **Fully Closed** | Terminal + `acknowledged_at` set + `comms_outcome` set |

**Fully-closed tasks remain open to `comms_outcome` revision** (see §5).

---

## 2. Role Responsibilities

| Role | Sets | Never Sets |
|------|------|-----------|
| **Orchestrator** | `status` (pending→completed/failed), `assignee`, `result`, `error`, `outcome`, `outcome_notes`, `work_notes`, `completed_at` (via status transition) | `acknowledged_at` on any non-terminal task ← **guard fires (409)** |
| **Comms agent** | `acknowledged_at`, `comms_outcome`, `comms_corrections` on any terminal task | Status fields (status changes are orch's job) |
| **Worker** | Reports to orch parent; parent sets `completed_at` | Direct DB writes outside daemon API |

**Comms must acknowledge EVERY Fully-closed task** — setting `acknowledged_at` + `comms_outcome` — before the task lifecycle is truly complete. Comms uses discretion on whether to involve the human (§4).

---

## 3. `comms_outcome` Enum

| Value | Meaning | When to use |
|-------|---------|-------------|
| `accepted` | Clean success, no issues | Task result matches expectations, human satisfied |
| `corrected` | Outcome differed from plan | Workers produced something different; `comms_corrections` explains delta |
| `redirected` | Work redirected mid-flight | Scope shifted during execution; outcome differs from original spec |
| `cancelled` | Task cancelled before completion | Use on cancelled tasks to confirm comms reviewed the cancellation |

**`comms_corrections`**: JSON blob. When `comms_outcome` is `corrected` or `redirected`, use this to record what actually happened vs. what was planned. Supports revision history by appending objects: `[{v: 1, note: "..."}, {v: 2, note: "..."}]`.

**Orch-side `outcome`** (distinct): `success | partial | failed | unknown` — set by orch at completion time, reflects technical execution quality, not comms assessment.

---

## 4. Comms Discretion — When to Ask the Human

Comms should not route every acknowledgement through the human. Use judgment:

| Auto-ack (comms decides alone) | Ask the human first |
|-------------------------------|---------------------|
| Internal background work (memory consolidation, retro spawning, scheduler tasks) | User-facing deliverables (emails sent, PRs opened, files written) |
| Low-risk, clearly successful (matching result + no errors + outcome=success) | Ambiguous result or partial outcome |
| Work the human delegated and confirmed specs for | Subjective satisfaction matters (design, copy, strategy) |
| Cancelled tasks where cancellation was human-initiated | Work that failed — always surface failures |

**Default**: if uncertain, ASK. Over-asking erodes trust; auto-acking too liberally creates silent failures. Both extremes are problems.

---

## 5. Revisable Feedback (NEW — Dave directive 2026-05-13 5:55 PM ET)

> "I don't think that a task needs to be reopened necessarily, but if it's not truly closed until it's been acknowledged by the comms agent, and the comms agent has supplied feedback on the success of the task, the comms agent just needs to be able to return to the task and change the feedback if they find out later that it was unsuccessful or that the human or it didn't meet requirements."

**Pattern**: Comms may `PUT /api/orchestrator/tasks/:id` with new `comms_outcome` and/or `comms_corrections` on a Fully-closed task. The task **remains closed** (status stays `completed`/`failed`/`cancelled`). Only feedback is updated.

**Example**: Comms initially acked a task as `accepted`. User later complains the output was wrong. Comms updates to `corrected` with `comms_corrections` JSON recording the discrepancy. The task history is now accurate without reopening.

**Guard**: `acknowledged_at` may only be set on terminal tasks (completed/failed/cancelled). Attempting to set it on an in-progress task returns 409 — prevents orch from pre-acking.

---

## 6. `generate_retro` — When to Flag a Task for Retrospective

| Field | Behavior |
|-------|----------|
| `generate_retro = true` | Forces a retro worker to be spawned for this specific task |
| `generate_retro = NULL` (default) | Defers to standard retro logic: `retro_all_terminal` global, then signal-based triggers (`on_error`, `on_retry`) |
| `generate_retro = false` | Suppresses retro even if global is true |

**Set `generate_retro = true`** when the task has retro signal worth preserving:
- Novel approach that worked (or failed) in a non-obvious way
- Unexpected complexity that revealed a gap in the playbook
- Instructive failure with a clear root cause
- First time a new tool/pattern was used at scale

**Default: leave NULL** — let the global decide. Don't spam retros on every task.

---

## 7. `complexity` Field

Rough sizing for ROI prioritization (future consumer). Set at task creation or update.

| Value | Rough range |
|-------|-------------|
| `S` | < 30 min |
| `M` | 30 min – 2 h |
| `L` | 2 – 8 h |
| `XL` | Multi-day |

---

## 8. `canonical_task_external_id` — Cross-Machine Coordination

When the same logical task is spawned on multiple machines (e.g., multi-agent workflows), set `canonical_task_external_id` to the same string on all instances. Agents use this to deduplicate and correlate work across machines without a shared DB.

Format: typically `<source>:<id>` (e.g., `github:issue-123`, `a2a:corr-abc`).

---

## 9. `timeout_seconds` Per-Task Field

Override the inactivity timeout for a specific task:

```
task.timeout_seconds → caps.inactivity_timeout_ms → built-in daemon default
```

Use for tasks you know will take longer than the default cap (e.g., long-running research, large builds). Set at creation or before assigning.

> **Note**: `timeout_seconds` per-task is being added by a sibling PR (`feat/pulse-and-q5-timeout`). Flag this section as pending if that PR has not yet merged.

---

## 10. Common Pitfalls

| Pitfall | Correct behavior |
|---------|-----------------|
| Orch sets `acknowledged_at` on a Dave-assigned task | 409 guard fires — only comms sets `acknowledged_at` |
| Comms asks human on every ack | Use discretion table (§4); auto-ack low-risk tasks |
| Comms auto-acks too liberally | Surface failures and ambiguous results to human |
| Treating Fully-closed feedback as set-once | `comms_outcome` + `comms_corrections` are revisable per Dave directive (§5) |
| Setting `generate_retro` on every task | Reserve for tasks with genuine retro signal (§6) |
| Mixing comms feedback with non-feedback fields in one PUT on a terminal task | 409 — comms-feedback PUT must not include `status`, `result`, `error`, etc. |

---

## 11. Quick API Reference

```bash
# Create a task
curl -s -X POST 'http://localhost:3847/api/orchestrator/tasks' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Do the thing","description":"Details","priority":0}'

# Advance to in_progress
curl -s -X PUT 'http://localhost:3847/api/orchestrator/tasks/<id>' \
  -H 'Content-Type: application/json' \
  -d '{"status":"assigned","assignee":"orchestrator"}'
curl -s -X PUT 'http://localhost:3847/api/orchestrator/tasks/<id>' \
  -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}'

# Complete with orch-side outcome
curl -s -X PUT 'http://localhost:3847/api/orchestrator/tasks/<id>' \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed","result":"Done","outcome":"success"}'

# Comms ack (first-time)
curl -s -X PUT 'http://localhost:3847/api/orchestrator/tasks/<id>' \
  -H 'Content-Type: application/json' \
  -d '{"comms_outcome":"accepted","acknowledged_at":"2026-05-13T17:55:00Z"}'

# Revise feedback (after-the-fact — Dave directive pattern)
curl -s -X PUT 'http://localhost:3847/api/orchestrator/tasks/<id>' \
  -H 'Content-Type: application/json' \
  -d '{
    "comms_outcome":"corrected",
    "comms_corrections":"{\"v1\":\"initially accepted\",\"v2\":\"user confirmed output was wrong\"}"
  }'

# Get task detail
curl -s 'http://localhost:3847/api/orchestrator/tasks/<id>'

# List pending tasks
curl -s 'http://localhost:3847/api/orchestrator/tasks?status=pending'
```
