# Task Queue ↔ Escalation Integration Design

## 1. What the Task Queue System Provides Today

### Tables (migration 008)
- **orchestrator_tasks** — id, title, description, status, assignee, priority (0/1/2), result, error, timeout_seconds, timestamps (created/assigned/started/completed/updated)
- **orchestrator_task_workers** — task_id ↔ worker_id mapping with role and assigned_at
- **orchestrator_task_activity** — per-task activity log (agent, type=progress|note, stage, message)

### State Machine
```
pending → assigned → in_progress → completed
  ↓          ↓           ↓
failed    failed       failed
           ↓
         pending (reassign)
```

### API Endpoints (task-queue.ts)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/orchestrator/tasks` | POST | Create a task |
| `/api/orchestrator/tasks` | GET | List tasks (filter by ?status=) |
| `/api/orchestrator/tasks/:id` | GET | Get task detail + workers + activity |
| `/api/orchestrator/tasks/:id` | PUT | Update task (status, assignee, result, error) |
| `/api/orchestrator/tasks/:id/activity` | POST | Post activity entry (progress entries forward to comms via injectMessage) |
| `/api/orchestrator/tasks/:id/activity` | GET | Get activity log (paginated) |
| `/api/orchestrator/tasks/:id/workers` | POST | Assign worker to task |

### Key Behavior
- Priority ordering: `ORDER BY priority DESC, created_at ASC` (urgent first, then FIFO)
- Status validation enforces valid transitions only
- Drift rules: pending requires null assignee; assigned requires non-null assignee
- Terminal states (completed/failed) block further updates
- Progress-type activity entries auto-inject into comms tmux session
- Worker assignment enforces uniqueness (task_id + worker_id)
- List endpoint enriches tasks with worker_count and latest_activity

### Current Problem: Completely Disconnected
The task queue tables exist and the API works, but:
- `POST /api/orchestrator/escalate` does NOT write to `orchestrator_tasks`
- The wrapper script polls `messages` table, not `orchestrator_tasks`
- No link between a message and a task
- Comms can't check task progress — only has the message system
- Workers spawned by the orchestrator aren't linked to tasks

---

## 2. Proposed Changes

### 2A. orchestrator.ts — Escalation Flow

**Current flow:**
1. Receive task + context
2. `isOrchestratorAlive()` → spawn or inject message
3. Write message to messages table via `sendMessage()`
4. Return 202 (spawned) or 200 (escalated)

**Proposed flow:**
1. Receive task + context
2. **Create task in orchestrator_tasks** (status: pending, priority from body or default 0)
3. `getOrchestratorState()` → returns 'active', 'waiting', or 'dead'
4. Based on state:
   - **'dead'** → spawn orchestrator, set task status to `assigned` (assignee: 'orchestrator'), include task_id in the prompt
   - **'waiting'** → inject task message with task_id, set status to `assigned`
   - **'active'** → queue only (leave as pending) — wrapper will pick it up after current Claude run ends
5. Still write message (for backward compat during transition), but include `task_id` in message metadata
6. Return task_id in response so comms can track it

**Key detail on 'active' state:** When the orchestrator Claude process is running, we can't inject a task mid-conversation (send-keys would just dump text into the conversation, which is unreliable). The correct behavior is to queue the task (leave it pending) and let the wrapper's polling loop pick it up after the current Claude run completes. This is a natural fit for the task queue.

**Code changes to `handleOrchestratorRoute`:**
```typescript
// In POST /api/orchestrator/escalate handler:

// 1. Create task record
const taskId = randomUUID();
const priority = typeof body.priority === 'number' ? body.priority : 0;
const ts = new Date().toISOString();
exec(
  `INSERT INTO orchestrator_tasks (id, title, description, status, priority, created_at, updated_at)
   VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
  taskId, task.slice(0, 200), task, priority, ts, ts
);

// 2. Check orchestrator state (not just alive)
const state = getOrchestratorState(); // 'active' | 'waiting' | 'dead'

// 3. Route based on state
if (state === 'dead') {
  // Spawn with task_id in prompt
  // Set task status: assigned, assignee: 'orchestrator'
} else if (state === 'waiting') {
  // Inject message with task_id — wrapper is in idle loop, will process next poll
  // Set task status: assigned, assignee: 'orchestrator'
} else {
  // state === 'active' — Claude is running, just queue it
  // Task stays pending — wrapper picks it up after current run
}

// 4. Also write message (backward compat), include task_id in metadata
sendMessage({
  from: 'comms',
  to: 'orchestrator',
  type: 'task',
  body: JSON.stringify({ task, context, task_id: taskId }),
  metadata: { task_id: taskId },
});

// 5. Return task_id in response
json(res, state === 'dead' ? 202 : 200, withTimestamp({
  status: state === 'dead' ? 'spawned' : (state === 'waiting' ? 'escalated' : 'queued'),
  task_id: taskId,
  message: '...',
}));
```

### 2B. Wrapper Script — Polling Changes

**Current behavior:**
- After Claude exits, polls `GET /api/messages?agent=orchestrator&since_id=X&type=task` every 10s for 2min
- Extracts task body from message JSON

**Proposed change — poll tasks table instead:**
```bash
# Replace message polling with task polling:
RESPONSE=$(curl -s -f "http://localhost:$DAEMON_PORT/api/orchestrator/tasks?status=pending,assigned" 2>/dev/null || printf '{"data":[]}')
COUNT=$(printf '%s' "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null || printf '0')

if [ "$COUNT" -gt "0" ]; then
  # Extract highest-priority pending/assigned task
  PARSED=$(printf '%s' "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tasks = d.get('data', [])
if tasks:
    task = tasks[0]  # Already sorted by priority DESC, created_at ASC
    print(task['id'])
    print(task.get('description') or task['title'])
")
  TASK_ID=$(printf '%s' "$PARSED" | head -1)
  TASK_BODY=$(printf '%s' "$PARSED" | tail -n +2)

  if [ -n "$TASK_BODY" ]; then
    # Claim the task: mark assigned → in_progress
    curl -s -o /dev/null -X PUT "http://localhost:$DAEMON_PORT/api/orchestrator/tasks/$TASK_ID" \
      -H "Content-Type: application/json" \
      -d '{"status":"assigned","assignee":"orchestrator"}'
    curl -s -o /dev/null -X PUT "http://localhost:$DAEMON_PORT/api/orchestrator/tasks/$TASK_ID" \
      -H "Content-Type: application/json" \
      -d '{"status":"in_progress"}'

    # Run Claude with the task
    printf '%s' "$TASK_BODY" > "$PROMPT_FILE"
    run_claude "$PROMPT_FILE"

    # After Claude exits, mark task completed
    # (The orchestrator Claude process itself should do this via API before exiting,
    #  but the wrapper can set a fallback completed status)
    elapsed=0
  fi
fi
```

**Keep message polling as fallback** — During transition, poll both. Messages without task_ids are legacy. Tasks table is primary.

### 2C. Alive Detection — Use getOrchestratorState()

**Current:** `isOrchestratorAlive()` — checks if tmux session exists. Returns true even when wrapper is idle-polling.

**Proposed:** Replace `isOrchestratorAlive()` with `getOrchestratorState()` in the escalation endpoint. The status endpoint already returns both.

The three states map to different actions:
- `dead` → need to spawn
- `waiting` → wrapper is idle-polling, can inject work immediately (or just let it find the pending task on next poll cycle — simpler)
- `active` → Claude is running, queue the task

**Simplification insight:** If we make the wrapper poll the tasks table reliably, we don't need to inject messages at all for the `waiting` case. Just create the task record and let the wrapper find it on its next 10s poll. This eliminates the tmux injection path for task delivery entirely, which is cleaner.

However, if the task is urgent (priority 2), we might want to inject a nudge into the wrapper to trigger an immediate poll rather than waiting up to 10s. This is an optimization, not a requirement for v1.

### 2D. Orchestrator-Side Task Lifecycle

The orchestrator Claude process needs to know about its task_id so it can:
1. Update status to `in_progress` when it starts working
2. Post activity entries as progress (`POST /api/orchestrator/tasks/:id/activity`)
3. Link spawned workers (`POST /api/orchestrator/tasks/:id/workers`)
4. Set result/error and mark `completed`/`failed` when done

**How to pass task_id to the orchestrator:**
- Include it in the prompt: `"Task ID: <uuid> — update status via /api/orchestrator/tasks/<uuid>"`
- The `buildOrchestratorPrompt()` function gets a new `taskId` parameter
- Add instructions to the orchestrator prompt about task lifecycle updates

### 2E. Comms-Side Task Tracking

Comms can now:
- Check task status: `GET /api/orchestrator/tasks/:id`
- See all active tasks: `GET /api/orchestrator/tasks?status=pending,assigned,in_progress`
- See task workers: included in task detail response
- See progress: activity entries (which also auto-inject into comms via tmux)
- See results: `result` field on completed tasks

The escalate response returns `task_id`, which comms stores and uses for follow-up queries.

---

## 3. Edge Cases and Concerns

### 3A. Task Timeout
The `orchestrator_tasks` table has `timeout_seconds`. The daemon should monitor for tasks stuck in `in_progress` beyond their timeout. If timeout expires:
- Mark task `failed` with error "timeout"
- Post activity entry
- If the orchestrator is dead, notify comms
- **v1: skip this.** Just document it as future work. The wrapper's 2-minute idle timeout is sufficient for now.

### 3B. Orphaned Tasks
If the orchestrator crashes mid-task, the task stays `in_progress` forever. Recovery:
- On orchestrator spawn, check for `in_progress` tasks with no live orchestrator → mark `failed` or re-queue as `pending`
- The existing orphan cleanup logic in the daemon restart flow should handle this
- **v1: add a simple check in spawnOrchestratorSession — if spawning fresh, fail any stale in_progress tasks**

### 3C. Multiple Pending Tasks
The escalation flow now queues tasks. When the wrapper polls, it picks the highest-priority, oldest task first. This naturally handles bursts of escalations — they queue up and get processed in order.

### 3D. Backward Compatibility
Messages table still gets written (with task_id in metadata). Old orchestrator prompts that don't know about task_id will still work — they just won't update task status. The wrapper can fall back to message polling if task polling returns empty.

### 3E. Race Condition: Wrapper Polls Between Status Updates
Between creating the task (pending) and setting it to assigned, the wrapper might grab it. This is fine — the wrapper claims it by setting assigned → in_progress. The escalation handler should handle the case where the task it just created is no longer pending (just skip the status update).

### 3F. Prompt Injection for Initial Task
For the spawn case (dead → spawn), the task_id and lifecycle instructions go into the initial prompt via `buildOrchestratorPrompt()`. For the wrapper-polls-tasks case, the wrapper needs to build a prompt that includes the task_id and instructions. This means the wrapper script needs the task lifecycle instructions embedded.

---

## 4. Implementation Order

1. **orchestrator.ts** — Modify escalate endpoint: create task record, use getOrchestratorState(), return task_id
2. **orchestrator.ts** — Modify buildOrchestratorPrompt(): accept and include task_id, add lifecycle instructions
3. **tmux.ts** — Modify wrapper script: poll orchestrator_tasks, claim and update status, mark completed on exit
4. **orchestrator.ts** — Add orphan recovery on spawn (fail stale in_progress tasks)
5. **Test** — End-to-end: escalate → task created → orchestrator spawns → task assigned → completed → comms checks status

Estimated scope: ~150-200 lines changed across 2 files (orchestrator.ts, tmux.ts). No new files, no new tables, no migration needed.
