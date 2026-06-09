/**
 * Task Queue API — structured task management for orchestrator work.
 *
 * TODO(PR-C): /api/orchestrator/tasks shim reading from unified tasks table
 * instead of orchestrator_tasks — deprecate orchestrator_tasks in next release.
 *
 * State machine: pending → assigned → in_progress → completed/failed/cancelled
 *                                    in_progress → awaiting_approval → in_progress (approved/rejected)
 * Retry: failed → pending (increments retry_count)
 *
 * Routes:
 *   POST   /api/orchestrator/tasks                       — Create a task
 *   GET    /api/orchestrator/tasks                       — List tasks (filterable by status)
 *   GET    /api/orchestrator/tasks/:id                   — Get task detail (+ workers + activity)
 *   PUT    /api/orchestrator/tasks/:id                   — Update task (status, assignee, result)
 *   POST   /api/orchestrator/tasks/:id/activity          — Post activity entry
 *   GET    /api/orchestrator/tasks/:id/activity          — Get activity log (paginated)
 *   POST   /api/orchestrator/tasks/:id/workers           — Assign worker to task
 *   POST   /api/orchestrator/tasks/:id/retry             — Retry a failed task
 *   POST   /api/orchestrator/tasks/:id/cancel            — Cancel a pending/in_progress task
 *   POST   /api/orchestrator/tasks/:id/submit-plan       — Submit plan for human approval
 *   POST   /api/orchestrator/tasks/:id/approve-plan      — Approve a submitted plan
 *   POST   /api/orchestrator/tasks/:id/reject-plan       — Reject a submitted plan
 */

import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { json, withTimestamp, parseBody } from './helpers.js';
import { query, exec, getDatabase } from '../core/db.js';
import { injectMessage } from '../agents/tmux.js';
import { createLogger } from '../core/logger.js';
import { storeMemoryInternal } from './memory.js';
import { evaluateTask as _evaluateTask } from '../self-improvement/retro-evaluator.js';

// Injectable for testing — allows tests to mock evaluateTask without spawning real workers
let _evalFn: (taskId: string) => Promise<void> = _evaluateTask;
export function _setEvaluateTaskFnForTesting(fn: ((taskId: string) => Promise<void>) | null): void {
  _evalFn = fn ?? _evaluateTask;
}

const log = createLogger('task-queue');

// ── Types ────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
type ActivityType = 'progress' | 'note';

type TaskOutcome = 'success' | 'partial' | 'failed' | 'unknown';
type CommsOutcome = 'accepted' | 'corrected' | 'redirected' | 'cancelled';
type Complexity = 'S' | 'M' | 'L' | 'XL';

const VALID_OUTCOMES: readonly TaskOutcome[] = ['success', 'partial', 'failed', 'unknown'];
const VALID_COMMS_OUTCOMES: readonly CommsOutcome[] = ['accepted', 'corrected', 'redirected', 'cancelled'];
const VALID_COMPLEXITY: readonly Complexity[] = ['S', 'M', 'L', 'XL'];

/**
 * Unified tasks table row shape — matches the schema from migration 024.
 */
interface UnifiedTask {
  id: number;
  external_id: string | null;
  kind: 'todo' | 'orchestrator';
  title: string;
  description: string | null;
  status: string;
  assigned_to: string | null;
  priority: string;
  result: string | null;
  error: string | null;
  retry_count: number;
  work_notes: string | null;
  timeout_seconds: number | null;
  outcome: string | null;
  outcome_reason: string | null;
  source: string | null;
  comms_outcome: string | null;
  comms_corrections: string | null;
  acknowledged_at: string | null;
  complexity: number | null;
  generate_retro: number | null;
  canonical_task_external_id: string | null;
  requesting_peer: string | null;
  plan: string | null;
  plan_status: string | null;
  plan_submitted_at: string | null;
  plan_approved_at: string | null;
  plan_rejected_reason: string | null;
  created_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

/**
 * Legacy OrchestratorTask response shape — preserved for API compat.
 * Callers expect `id` as UUID, `assignee`, `priority` as number, `outcome_notes`.
 */
interface OrchestratorTask {
  id: string;
  _int_id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  priority: number;
  result: string | null;
  error: string | null;
  retry_count: number;
  work_notes: string | null;
  timeout_seconds: number | null;
  outcome: TaskOutcome | null;
  outcome_notes: string | null;
  source: string | null;
  comms_outcome: CommsOutcome | null;
  comms_corrections: string | null;
  acknowledged_at: string | null;
  complexity: Complexity | null;
  generate_retro: number | null;
  canonical_task_external_id: string | null;
  plan: string | null;
  plan_status: 'submitted' | 'approved' | 'rejected' | null;
  plan_submitted_at: string | null;
  plan_approved_at: string | null;
  plan_rejected_reason: string | null;
  created_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface TaskWorker {
  task_id: number;
  worker_id: string;
  role: string | null;
  assigned_at: string;
}

interface TaskActivity {
  id: number;
  task_id: number;
  agent: string;
  type: ActivityType;
  stage: string | null;
  message: string;
  created_at: string;
}

// ── Constants ────────────────────────────────────────────────

const VALID_STATUSES: readonly TaskStatus[] = ['pending', 'assigned', 'in_progress', 'awaiting_approval', 'completed', 'failed', 'cancelled'];
const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];
const VALID_ACTIVITY_TYPES: readonly ActivityType[] = ['progress', 'note'];

/**
 * Valid status transitions. Key = current status, value = allowed next statuses.
 */
const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['assigned', 'failed', 'cancelled'],
  assigned: ['in_progress', 'failed', 'pending', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled', 'awaiting_approval'],
  awaiting_approval: ['in_progress', 'cancelled'],
  completed: [],
  failed: ['pending'],  // retry: failed → pending
  cancelled: [],
};

// ── Complexity mapping ────────────────────────────────────────

/**
 * Convert integer complexity (tasks table) to legacy string (S/M/L/XL).
 * The unified schema stores 1-4; old callers expect S/M/L/XL.
 */
function intToComplexity(n: number | null): Complexity | null {
  if (n === null || n === undefined) return null;
  const map: Record<number, Complexity> = { 1: 'S', 2: 'M', 3: 'L', 4: 'XL' };
  return map[n] ?? null;
}

/**
 * Convert legacy complexity string to integer for storage.
 */
function complexityToInt(s: Complexity | null | undefined): number | null {
  if (!s) return null;
  const map: Record<Complexity, number> = { S: 1, M: 2, L: 3, XL: 4 };
  return map[s] ?? null;
}

/**
 * Convert text priority (tasks table) to legacy numeric priority.
 * Inverts legacyIntToPriorityText to preserve round-trip for 0/1/2:
 *   low→0, medium→1, urgent→2
 * Also handles migration-era values: high→1 (closest to medium), mapped data.
 */
function priorityTextToLegacyInt(p: string | null): number {
  if (!p) return 0;
  const map: Record<string, number> = { low: 0, medium: 1, high: 1, urgent: 2 };
  return map[p] ?? 0;
}

/**
 * Convert legacy numeric priority (0/1/2) to unified text priority.
 * Chosen so alphabetical DESC sort preserves the expected priority order:
 *   2 (urgent) > 1 (medium) > 0 (low)
 * Alphabetical DESC: urgent > medium > low ✓
 */
export function legacyIntToPriorityText(n: number): string {
  if (n <= 0) return 'low';
  if (n === 1) return 'medium';
  return 'urgent'; // 2+
}

// ── Response mapper ───────────────────────────────────────────

/**
 * Map a UnifiedTask row to the legacy OrchestratorTask response shape.
 * Preserves all field names that existing callers expect.
 */
function taskToOrchestratorResponse(task: UnifiedTask): OrchestratorTask {
  return {
    id: task.external_id ?? String(task.id),
    _int_id: task.id,
    title: task.title,
    description: task.description,
    status: task.status as TaskStatus,
    assignee: task.assigned_to,
    priority: priorityTextToLegacyInt(task.priority),
    result: task.result,
    error: task.error,
    retry_count: task.retry_count,
    work_notes: task.work_notes,
    timeout_seconds: task.timeout_seconds,
    outcome: (task.outcome as TaskOutcome) ?? null,
    outcome_notes: task.outcome_reason,
    source: task.source,
    comms_outcome: (task.comms_outcome as CommsOutcome) ?? null,
    comms_corrections: task.comms_corrections,
    acknowledged_at: task.acknowledged_at,
    complexity: intToComplexity(task.complexity),
    generate_retro: task.generate_retro,
    canonical_task_external_id: task.canonical_task_external_id,
    plan: task.plan,
    plan_status: task.plan_status as OrchestratorTask['plan_status'],
    plan_submitted_at: task.plan_submitted_at,
    plan_approved_at: task.plan_approved_at,
    plan_rejected_reason: task.plan_rejected_reason,
    created_at: task.created_at,
    assigned_at: task.assigned_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
    updated_at: task.updated_at,
  };
}

// ── Validation ───────────────────────────────────────────────

/**
 * Validate status + assignee combination per spec drift rules.
 * Returns error string or null if valid.
 */
function validateStatusAssignee(status: TaskStatus, assignee: string | null): string | null {
  if (status === 'pending' && assignee !== null) {
    return 'pending tasks must have null assignee';
  }
  if (status === 'assigned' && !assignee) {
    return 'assigned tasks require a non-null assignee';
  }
  // awaiting_approval keeps its assignee (like in_progress) — no validation needed
  return null;
}

// ── Helpers ──────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function extractTaskId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)/);
  return match ? match[1]! : null;
}

/**
 * Look up an orchestrator task from the unified `tasks` table.
 * Accepts either:
 *   - a UUID string (matched against external_id) — the normal case for orch tasks
 *   - a numeric string (matched against integer id) — legacy / testing path
 *
 * The kind='orchestrator' filter prevents accidental cross-kind collisions:
 * if tasks.id=N belongs to a todo row, a numeric lookup for N will correctly
 * return undefined rather than the wrong task.
 */
function getTask(id: string): UnifiedTask | undefined {
  const db = getDatabase();
  if (/^\d+$/.test(id)) {
    return db.prepare("SELECT * FROM tasks WHERE id = ? AND kind = 'orchestrator'").get(parseInt(id, 10)) as UnifiedTask | undefined;
  }
  return db.prepare("SELECT * FROM tasks WHERE external_id = ? AND kind = 'orchestrator'").get(id) as UnifiedTask | undefined;
}

function getTaskWorkers(taskIntId: number): TaskWorker[] {
  return query<TaskWorker>(
    'SELECT * FROM task_workers WHERE task_id = ? ORDER BY assigned_at ASC',
    taskIntId,
  );
}

function getTaskActivity(taskIntId: number, limit = 50, offset = 0): { data: TaskActivity[]; total: number } {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const safeOffset = Math.max(0, offset);

  const countRow = query<{ count: number }>(
    'SELECT COUNT(*) as count FROM task_activity WHERE task_id = ?',
    taskIntId,
  );
  const total = countRow[0]?.count ?? 0;

  const data = query<TaskActivity>(
    'SELECT * FROM task_activity WHERE task_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    taskIntId, safeLimit, safeOffset,
  );

  return { data, total };
}

// ── Route handler ────────────────────────────────────────────

export async function handleTaskQueueRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // Only handle /api/orchestrator/tasks* routes
  if (!pathname.startsWith('/api/orchestrator/tasks')) return false;

  try {
    // POST /api/orchestrator/tasks — create a task
    if (pathname === '/api/orchestrator/tasks' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.title || typeof body.title !== 'string') {
        json(res, 400, withTimestamp({ error: 'title is required' }));
        return true;
      }

      const priority = typeof body.priority === 'number' ? body.priority : 0;
      if (priority < 0 || priority > 2) {
        json(res, 400, withTimestamp({ error: 'priority must be 0 (normal), 1 (high), or 2 (urgent)' }));
        return true;
      }

      const externalId = randomUUID();
      const ts = now();

      // Validate and sanitize requesting_peer: lowercase alphanumeric/dash/underscore, 1..64 chars.
      let requestingPeer: string | null = null;
      if (typeof body.requesting_peer === 'string') {
        const trimmed = body.requesting_peer.trim().toLowerCase();
        if (trimmed.length >= 1 && trimmed.length <= 64 && /^[a-z0-9_-]+$/.test(trimmed)) {
          requestingPeer = trimmed;
        }
      }

      const source = typeof body.source === 'string' ? body.source : 'orchestrator';
      const priorityText = legacyIntToPriorityText(priority);
      const complexityInt = typeof body.complexity === 'string' && VALID_COMPLEXITY.includes(body.complexity as Complexity)
        ? complexityToInt(body.complexity as Complexity)
        : null;

      exec(
        `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, work_notes, timeout_seconds, complexity, canonical_task_external_id, requesting_peer, created_at, updated_at)
         VALUES (?, 'orchestrator', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        externalId,
        body.title,
        typeof body.description === 'string' ? body.description : null,
        priorityText,
        source,
        typeof body.work_notes === 'string' ? body.work_notes : null,
        typeof body.timeout_seconds === 'number' ? body.timeout_seconds : null,
        complexityInt,
        typeof body.canonical_task_external_id === 'string' ? body.canonical_task_external_id : null,
        requestingPeer,
        ts,
        ts,
      );

      const task = getTask(externalId)!;
      const mapped = taskToOrchestratorResponse(task);
      log.info('Task created', { id: externalId, title: task.title, priority });
      json(res, 201, withTimestamp(mapped));
      return true;
    }

    // GET /api/orchestrator/tasks — list tasks
    if (pathname === '/api/orchestrator/tasks' && method === 'GET') {
      const statusFilter = searchParams.get('status');
      let tasks: UnifiedTask[];

      if (statusFilter) {
        const statuses = statusFilter.split(',').map(s => s.trim());
        const invalid = statuses.filter(s => !VALID_STATUSES.includes(s as TaskStatus));
        if (invalid.length > 0) {
          json(res, 400, withTimestamp({ error: `invalid status filter: ${invalid.join(', ')}` }));
          return true;
        }
        const placeholders = statuses.map(() => '?').join(',');
        tasks = query<UnifiedTask>(
          `SELECT * FROM tasks WHERE kind = 'orchestrator' AND status IN (${placeholders}) ORDER BY priority DESC, created_at ASC`,
          ...statuses,
        );
      } else {
        tasks = query<UnifiedTask>(
          "SELECT * FROM tasks WHERE kind = 'orchestrator' AND status != 'cancelled' ORDER BY priority DESC, created_at ASC",
        );
      }

      // Attach latest activity and worker count to each task
      const enriched = tasks.map(task => {
        const workers = getTaskWorkers(task.id);
        const latestActivity = query<TaskActivity>(
          'SELECT * FROM task_activity WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
          task.id,
        );
        return {
          ...taskToOrchestratorResponse(task),
          worker_count: workers.length,
          latest_activity: latestActivity[0] ?? null,
        };
      });

      json(res, 200, withTimestamp({ data: enriched }));
      return true;
    }

    // Routes with task ID
    const taskId = extractTaskId(pathname);
    if (!taskId) return false;

    // Check for sub-routes: /activity, /workers
    const subpath = pathname.slice(`/api/orchestrator/tasks/${taskId}`.length);

    // GET /api/orchestrator/tasks/:id/activity — get activity log
    if (subpath === '/activity' && method === 'GET') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const limit = parseInt(searchParams.get('limit') ?? '50', 10);
      const offset = parseInt(searchParams.get('offset') ?? '0', 10);
      const result = getTaskActivity(task.id, isNaN(limit) ? 50 : limit, isNaN(offset) ? 0 : offset);

      json(res, 200, withTimestamp({ data: result.data, total: result.total }));
      return true;
    }

    // POST /api/orchestrator/tasks/:id/activity — post activity entry
    if (subpath === '/activity' && method === 'POST') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const body = await parseBody(req);

      if (!body.message || typeof body.message !== 'string') {
        json(res, 400, withTimestamp({ error: 'message is required' }));
        return true;
      }

      const type = (typeof body.type === 'string' ? body.type : 'note') as ActivityType;
      if (!VALID_ACTIVITY_TYPES.includes(type)) {
        json(res, 400, withTimestamp({ error: `type must be one of: ${VALID_ACTIVITY_TYPES.join(', ')}` }));
        return true;
      }

      const agent = typeof body.agent === 'string' ? body.agent : 'unknown';
      const stage = typeof body.stage === 'string' ? body.stage : null;
      const ts = now();

      exec(
        `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        task.id, agent, type, stage, body.message, ts,
      );

      // For progress updates, forward to comms session immediately
      if (type === 'progress') {
        const prefix = stage ? `${stage}: ` : '';
        injectMessage('comms', `[task ${task.title}] ${prefix}${body.message}`);
      }

      const entry = query<TaskActivity>(
        'SELECT * FROM task_activity WHERE task_id = ? ORDER BY id DESC LIMIT 1',
        task.id,
      );

      log.info('Activity posted', { taskId, type, agent });
      json(res, 201, withTimestamp(entry[0]!));
      return true;
    }

    // POST /api/orchestrator/tasks/:id/workers — assign worker to task
    if (subpath === '/workers' && method === 'POST') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (TERMINAL_STATUSES.includes(task.status as TaskStatus)) {
        json(res, 409, withTimestamp({ error: `Cannot assign workers to ${task.status} task` }));
        return true;
      }

      const body = await parseBody(req);

      if (!body.worker_id || typeof body.worker_id !== 'string') {
        json(res, 400, withTimestamp({ error: 'worker_id is required' }));
        return true;
      }

      const role = typeof body.role === 'string' ? body.role : null;
      const ts = now();

      try {
        exec(
          'INSERT INTO task_workers (task_id, worker_id, role, assigned_at) VALUES (?, ?, ?, ?)',
          task.id, body.worker_id, role, ts,
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
          json(res, 409, withTimestamp({ error: 'Worker already assigned to this task' }));
          return true;
        }
        throw err;
      }

      log.info('Worker assigned to task', { taskId, workerId: body.worker_id, role });
      json(res, 201, withTimestamp({ task_id: task.external_id ?? String(task.id), worker_id: body.worker_id, role, assigned_at: ts }));
      return true;
    }


    // POST /api/orchestrator/tasks/:id/retry — retry a failed task
    if (subpath === '/retry' && method === 'POST') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (task.status !== 'failed') {
        json(res, 409, withTimestamp({ error: `Can only retry failed tasks, current status: ${task.status}` }));
        return true;
      }

      const ts = now();
      const newRetryCount = (task.retry_count ?? 0) + 1;

      exec(
        `UPDATE tasks SET status = 'pending', assigned_to = NULL, error = NULL, result = NULL, retry_count = ?, completed_at = NULL, updated_at = ? WHERE id = ?`,
        newRetryCount, ts, task.id,
      );

      // Log retry activity
      exec(
        `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
         VALUES (?, 'daemon', 'note', 'retry', ?, ?)`,
        task.id, `Task retried (attempt ${newRetryCount + 1})`, ts,
      );

      // Alert comms after 2 consecutive failures
      if (newRetryCount >= 2) {
        injectMessage('comms', `[task alert] "${task.title}" has failed ${newRetryCount} times and is being retried (attempt ${newRetryCount + 1})`);
      }

      const updated = getTask(taskId)!;
      log.info('Task retried', { id: taskId, retry_count: newRetryCount });
      json(res, 200, withTimestamp(taskToOrchestratorResponse(updated)));
      return true;
    }

    // POST /api/orchestrator/tasks/:id/cancel — cancel a task
    if (subpath === '/cancel' && method === 'POST') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (TERMINAL_STATUSES.includes(task.status as TaskStatus)) {
        json(res, 409, withTimestamp({ error: `Cannot cancel ${task.status} task` }));
        return true;
      }

      const ts = now();

      // If in_progress, kill assigned workers first
      if (task.status === 'in_progress') {
        const workers = getTaskWorkers(task.id);
        for (const w of workers) {
          try {
            // Mark worker job as cancelled in DB
            exec(
              `UPDATE worker_jobs SET status = 'failed', error = 'parent task cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'running')`,
              ts, w.worker_id,
            );
          } catch {
            // Worker may not exist or already finished
          }
        }
      }

      exec(
        `UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?`,
        ts, ts, task.id,
      );

      // Log cancellation activity
      exec(
        `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
         VALUES (?, 'daemon', 'note', 'cancelled', 'Task cancelled', ?)`,
        task.id, ts,
      );

      const updated = getTask(taskId)!;
      log.info('Task cancelled', { id: taskId, previous_status: task.status });
      json(res, 200, withTimestamp(taskToOrchestratorResponse(updated)));
      return true;
    }

    // POST /api/orchestrator/tasks/:id/submit-plan — submit plan for human approval
    if (subpath === '/submit-plan' && method === 'POST') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (task.status !== 'in_progress') {
        json(res, 409, withTimestamp({ error: `Can only submit a plan for in_progress tasks, current status: ${task.status}` }));
        return true;
      }

      const body = await parseBody(req);

      if (!body.plan || typeof body.plan !== 'string') {
        json(res, 400, withTimestamp({ error: 'plan is required and must be a string' }));
        return true;
      }

      const ts = now();
      const resolvedTaskId = task.external_id ?? String(task.id);

      getDatabase().transaction(() => {
        exec(
          `UPDATE tasks SET plan = ?, plan_status = 'submitted', plan_submitted_at = ?, status = 'awaiting_approval', updated_at = ? WHERE id = ?`,
          body.plan, ts, ts, task.id,
        );

        exec(
          `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'orchestrator', 'note', 'plan_submitted', 'Plan submitted for human approval', ?)`,
          task.id, ts,
        );
      })();

      // Notify comms via DB message
      const planPreview = (body.plan as string).slice(0, 500);
      const notifyBody = `[plan approval needed] Task "${task.title.slice(0, 80)}" has submitted a plan for review.\n\nPlan:\n${planPreview}${(body.plan as string).length > 500 ? '\n...(truncated)' : ''}\n\nApprove: curl -s -X POST 'http://localhost:3847/api/orchestrator/tasks/${resolvedTaskId}/approve-plan' -H 'Content-Type: application/json' -d '{}'\nReject: curl -s -X POST 'http://localhost:3847/api/orchestrator/tasks/${resolvedTaskId}/reject-plan' -H 'Content-Type: application/json' -d '{"reason":"..."}'`;

      try {
        exec(
          `INSERT INTO messages (from_agent, to_agent, type, body, created_at) VALUES ('daemon', 'comms', 'task', ?, ?)`,
          notifyBody, ts,
        );
      } catch (err) {
        log.warn('Failed to insert plan approval message to comms', { taskId, error: String(err) });
      }

      // Also inject directly into comms tmux session for immediate visibility
      try {
        injectMessage('comms', notifyBody);
      } catch (e) {
        log.warn('Failed to inject plan submission notification to comms', { taskId, error: String(e) });
      }

      const updated = getTask(taskId)!;
      log.info('Plan submitted for approval', { taskId, title: task.title });
      json(res, 200, withTimestamp(taskToOrchestratorResponse(updated)));
      return true;
    }

    // POST /api/orchestrator/tasks/:id/approve-plan — approve a submitted plan
    if (subpath === '/approve-plan' && method === 'POST') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (task.status !== 'awaiting_approval') {
        json(res, 409, withTimestamp({ error: `Can only approve plans for awaiting_approval tasks, current status: ${task.status}` }));
        return true;
      }

      if (task.plan_status !== 'submitted') {
        json(res, 409, withTimestamp({ error: `Can only approve tasks with plan_status=submitted, current plan_status: ${task.plan_status}` }));
        return true;
      }

      const ts = now();

      getDatabase().transaction(() => {
        exec(
          `UPDATE tasks SET plan_status = 'approved', plan_approved_at = ?, status = 'in_progress', updated_at = ? WHERE id = ?`,
          ts, ts, task.id,
        );

        exec(
          `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'daemon', 'note', 'plan_approved', 'Plan approved — resuming execution', ?)`,
          task.id, ts,
        );
      })();

      // Notify orchestrator
      const resolvedTaskId = task.external_id ?? String(task.id);
      const approveMsg = `[System] Plan approved for task ${resolvedTaskId}. Resume execution.`;
      try {
        exec(
          `INSERT INTO messages (from_agent, to_agent, type, body, created_at) VALUES ('daemon', 'orchestrator', 'task', ?, ?)`,
          approveMsg, ts,
        );
      } catch (err) {
        log.warn('Failed to insert plan approval notification to orchestrator', { taskId, error: String(err) });
      }

      try {
        injectMessage('orchestrator', approveMsg);
      } catch (e) {
        log.warn('Failed to inject plan approval notification to orchestrator', { taskId, error: String(e) });
      }

      const updated = getTask(taskId)!;
      log.info('Plan approved', { taskId, title: task.title });
      json(res, 200, withTimestamp(taskToOrchestratorResponse(updated)));
      return true;
    }

    // POST /api/orchestrator/tasks/:id/reject-plan — reject a submitted plan
    if (subpath === '/reject-plan' && method === 'POST') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (task.status !== 'awaiting_approval') {
        json(res, 409, withTimestamp({ error: `Can only reject plans for awaiting_approval tasks, current status: ${task.status}` }));
        return true;
      }

      if (task.plan_status !== 'submitted') {
        json(res, 409, withTimestamp({ error: `Can only reject tasks with plan_status=submitted, current plan_status: ${task.plan_status}` }));
        return true;
      }

      const body = await parseBody(req);
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'No reason provided';

      const ts = now();

      getDatabase().transaction(() => {
        exec(
          `UPDATE tasks SET plan_status = 'rejected', plan_rejected_reason = ?, status = 'in_progress', updated_at = ? WHERE id = ?`,
          reason, ts, task.id,
        );

        exec(
          `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'daemon', 'note', 'plan_rejected', ?, ?)`,
          task.id, `Plan rejected. Reason: ${reason}`, ts,
        );
      })();

      // Notify orchestrator
      const resolvedTaskId = task.external_id ?? String(task.id);
      const rejectMsg = `[System] Plan rejected for task ${resolvedTaskId}. Reason: ${reason}. Revise and resubmit.`;
      try {
        exec(
          `INSERT INTO messages (from_agent, to_agent, type, body, created_at) VALUES ('daemon', 'orchestrator', 'task', ?, ?)`,
          rejectMsg, ts,
        );
      } catch (err) {
        log.warn('Failed to insert plan rejection notification to orchestrator', { taskId, error: String(err) });
      }

      try {
        injectMessage('orchestrator', rejectMsg);
      } catch (e) {
        log.warn('Failed to inject plan rejection notification to orchestrator', { taskId, error: String(e) });
      }

      const updated = getTask(taskId)!;
      log.info('Plan rejected', { taskId, title: task.title, reason });
      json(res, 200, withTimestamp(taskToOrchestratorResponse(updated)));
      return true;
    }

    // GET /api/orchestrator/tasks/:id — get task detail
    if (!subpath && method === 'GET') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const workers = getTaskWorkers(task.id);
      const activity = getTaskActivity(task.id);

      json(res, 200, withTimestamp({
        ...taskToOrchestratorResponse(task),
        workers,
        activity: activity.data,
        activity_total: activity.total,
      }));
      return true;
    }

    // PUT /api/orchestrator/tasks/:id — update task
    if (!subpath && method === 'PUT') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const body = await parseBody(req);

      // Comms feedback fields (comms_outcome, comms_corrections, acknowledged_at) are exempt
      // from the terminal-task guard — comms may revise its assessment after the fact.
      // Guard: acknowledged_at may only be set on terminal tasks (prevents premature ack).
      const hasCommsFeedback = body.comms_outcome !== undefined
        || body.comms_corrections !== undefined
        || body.acknowledged_at !== undefined;
      const hasNonFeedbackFields = body.status !== undefined
        || body.assignee !== undefined
        || body.result !== undefined
        || body.error !== undefined
        || body.work_notes !== undefined
        || body.outcome !== undefined
        || body.outcome_notes !== undefined
        || body.plan !== undefined;

      // Block acknowledged_at on non-terminal tasks (orch cannot pre-ack Dave-todos)
      if (body.acknowledged_at !== undefined && !TERMINAL_STATUSES.includes(task.status as TaskStatus)) {
        json(res, 409, withTimestamp({ error: 'acknowledged_at can only be set on terminal tasks (completed/failed/cancelled)' }));
        return true;
      }

      // Guard: only comms may set acknowledged_at on tasks with source='human'.
      // Rationale: source='human' tasks come from /api/orchestrator/escalate — they
      // represent explicit human commitments. Orchestrator self-closing them would
      // shortcut the human-visible ack flow. Orch can still close its own
      // source='orchestrator' (or NULL/legacy) tasks freely.
      if (body.acknowledged_at !== undefined && task.source === 'human') {
        const caller = (req.headers['x-agent'] as string | undefined)?.toLowerCase();
        if (caller !== 'comms') {
          json(res, 403, withTimestamp({
            error: 'acknowledged_at on source=human tasks may only be set by the comms agent',
            caller: caller ?? null,
          }));
          return true;
        }
      }

      // awaiting_approval is not terminal — it can transition back to in_progress.
      // Terminal tasks block non-feedback updates; comms-feedback-only updates are allowed.
      if (TERMINAL_STATUSES.includes(task.status as TaskStatus)) {
        if (hasNonFeedbackFields || !hasCommsFeedback) {
          json(res, 409, withTimestamp({ error: `Cannot update ${task.status} task` }));
          return true;
        }
        // Comms-feedback-only update on terminal task — proceed below.
      }
      const ts = now();
      const updates: Record<string, unknown> = { updated_at: ts };

      // Determine the target status and assignee (using unified column names)
      let targetStatus = task.status as TaskStatus;
      let targetAssignee = task.assigned_to;

      if (body.status !== undefined) {
        const newStatus = body.status as TaskStatus;
        if (!VALID_STATUSES.includes(newStatus)) {
          json(res, 400, withTimestamp({ error: `invalid status: ${body.status}` }));
          return true;
        }

        // Validate transition
        const allowed = VALID_TRANSITIONS[task.status as TaskStatus];
        if (!allowed.includes(newStatus)) {
          json(res, 409, withTimestamp({
            error: `cannot transition from ${task.status} to ${newStatus}`,
            allowed_transitions: allowed,
          }));
          return true;
        }

        targetStatus = newStatus;
        updates.status = newStatus;

        // Set timestamp fields based on status
        if (newStatus === 'assigned' && !task.assigned_at) {
          updates.assigned_at = ts;
        }
        if (newStatus === 'in_progress' && !task.started_at) {
          updates.started_at = ts;
        }
        if (TERMINAL_STATUSES.includes(newStatus)) {
          updates.completed_at = ts;
        }

        // Drift rule: setting status to 'pending' clears assignee
        if (newStatus === 'pending') {
          targetAssignee = null;
          updates.assigned_to = null;
        }
      }

      // Accept `assignee` in request body for compat — map to `assigned_to` in DB
      if (body.assignee !== undefined) {
        targetAssignee = body.assignee as string | null;
        updates.assigned_to = body.assignee;
        if (body.assignee && !task.assigned_at && !updates.assigned_at) {
          updates.assigned_at = ts;
        }
      }

      if (body.result !== undefined) {
        updates.result = body.result;
      }
      if (body.error !== undefined) {
        updates.error = body.error;
      }
      if (body.work_notes !== undefined) {
        if (body.append_work_notes && task.work_notes) {
          // Append to existing notes with timestamp separator
          const ts_note = new Date().toISOString().slice(0, 19).replace('T', ' ');
          updates.work_notes = `${task.work_notes}\n\n[${ts_note}] ${body.work_notes}`;
        } else if (body.append_work_notes && !task.work_notes) {
          // First note — no separator needed
          const ts_note = new Date().toISOString().slice(0, 19).replace('T', ' ');
          updates.work_notes = `[${ts_note}] ${body.work_notes}`;
        } else {
          updates.work_notes = body.work_notes;
        }
      }
      if (body.outcome !== undefined) {
        if (body.outcome !== null && !VALID_OUTCOMES.includes(body.outcome as TaskOutcome)) {
          json(res, 400, withTimestamp({ error: `outcome must be one of: ${VALID_OUTCOMES.join(', ')}` }));
          return true;
        }
        updates.outcome = body.outcome ?? null;
      }
      // Accept `outcome_notes` in request body for compat — map to `outcome_reason` in DB
      if (body.outcome_notes !== undefined) {
        updates.outcome_reason = typeof body.outcome_notes === 'string' ? body.outcome_notes : null;
      }

      // v2.1 fields — complexity (accept S/M/L/XL, store as integer), generate_retro, canonical_task_external_id
      if (body.complexity !== undefined) {
        if (body.complexity !== null && !VALID_COMPLEXITY.includes(body.complexity as Complexity)) {
          json(res, 400, withTimestamp({ error: `complexity must be one of: ${VALID_COMPLEXITY.join(', ')}` }));
          return true;
        }
        updates.complexity = body.complexity !== null ? complexityToInt(body.complexity as Complexity) : null;
      }
      if (body.generate_retro !== undefined) {
        updates.generate_retro = body.generate_retro === null ? null : (body.generate_retro ? 1 : 0);
      }
      if (body.canonical_task_external_id !== undefined) {
        updates.canonical_task_external_id = typeof body.canonical_task_external_id === 'string'
          ? body.canonical_task_external_id
          : null;
      }

      // Comms feedback fields — revisable even on terminal tasks
      if (body.comms_outcome !== undefined) {
        if (body.comms_outcome !== null && !VALID_COMMS_OUTCOMES.includes(body.comms_outcome as CommsOutcome)) {
          json(res, 400, withTimestamp({ error: `comms_outcome must be one of: ${VALID_COMMS_OUTCOMES.join(', ')}` }));
          return true;
        }
        updates.comms_outcome = body.comms_outcome ?? null;
      }
      if (body.comms_corrections !== undefined) {
        updates.comms_corrections = typeof body.comms_corrections === 'string' ? body.comms_corrections : null;
      }
      if (body.acknowledged_at !== undefined) {
        updates.acknowledged_at = typeof body.acknowledged_at === 'string' ? body.acknowledged_at : null;
      }

      if (body.plan !== undefined) {
        // Block plan mutation while awaiting approval — what was approved must match what executes
        if (task.plan_status === 'submitted') {
          json(res, 409, withTimestamp({ error: 'Cannot modify plan while awaiting approval. Reject the current plan first.' }));
          return true;
        }
        updates.plan = typeof body.plan === 'string' ? body.plan : null;
      }

      // Validate the final status/assignee combination
      const validationError = validateStatusAssignee(targetStatus, targetAssignee);
      if (validationError) {
        json(res, 400, withTimestamp({ error: validationError }));
        return true;
      }

      // Build UPDATE statement
      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = Object.values(updates);
      exec(
        `UPDATE tasks SET ${setClauses} WHERE id = ?`,
        ...values, task.id,
      );

      // Auto-log activity on status change
      if (updates.status) {
        const activityMessage = updates.status === 'completed'
          ? `Status → completed. Result: ${(updates.result as string)?.slice(0, 200) ?? '(none)'}`
          : updates.status === 'failed'
            ? `Status → failed. Error: ${(updates.error as string)?.slice(0, 200) ?? '(none)'}`
            : `Status → ${updates.status}`;

        exec(
          `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'daemon', 'note', 'status_change', ?, ?)`,
          task.id, activityMessage, ts,
        );
      }

      const updated = getTask(taskId)!;
      const mappedUpdated = taskToOrchestratorResponse(updated);
      log.info('Task updated', { id: taskId, status: updated.status, assignee: updated.assigned_to });

      // Auto-notify comms on task completion/failure/cancellation
      if (updates.status && TERMINAL_STATUSES.includes(updates.status as TaskStatus)) {
        const msgBody = updates.status === 'completed'
          ? `Task completed: ${updated.title}\n\nResult: ${updated.result ?? '(no result provided)'}`
          : updates.status === 'cancelled'
            ? `Task cancelled: ${updated.title}`
            : `Task failed: ${updated.title}\n\nError: ${updated.error ?? '(no error details)'}`;

        try {
          exec(
            `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
             VALUES ('daemon', 'comms', 'result', ?, ?)`,
            msgBody, new Date().toISOString(),
          );
          log.info('Auto-notified comms of task completion', { taskId, status: updates.status });
        } catch (err) {
          log.warn('Failed to auto-notify comms', { taskId, error: String(err) });
        }

        // Also inject directly into comms tmux session for immediate visibility
        injectMessage('comms', `[task ${updates.status}] ${updated.title.slice(0, 100)}`);
      }

      // Auto-store completion memory when a task is marked completed with a result
      if (updates.status === 'completed' && updated.result) {
        try {
          const title = updated.title.substring(0, 100);
          const result = updated.result.substring(0, 200);
          const content = `Completed orchestrator task: ${title}. ${result}`;
          await storeMemoryInternal({
            content,
            category: 'event',
            tags: ['auto', 'task-completion'],
            source: 'task-completion',
            importance: 3,
            dedup: true,
          });
        } catch (err) {
          log.warn('Failed to auto-store task completion memory', { error: String(err) });
        }
      }

      // Non-blocking retro evaluation on the status transition to terminal state.
      // Skip for comms-feedback-only updates (updates.status is undefined in that case)
      // to avoid spawning duplicate retro workers on feedback revisions.
      //
      // Triggers if:
      //   (a) standard retro conditions (error/retry signals) — handled inside _evalFn, OR
      //   (b) per-task generate_retro flag is set to 1, OR
      //   (c) retro_all_terminal config knob is true (global override).
      if (updates.status && (targetStatus === 'completed' || targetStatus === 'failed')) {
        const { getSelfImprovementConfig: _getSIC } = await import('../self-improvement/config.js');
        const _sic = _getSIC();
        const perTaskRetro = updated.generate_retro === 1;
        const globalAll = _sic.retro.retro_all_terminal;
        // Pass the external_id (UUID) to the retro evaluator which still uses orchestrator_tasks
        const evalId = updated.external_id ?? String(updated.id);
        log.debug('[retro] triggering retro evaluation for task', { taskId, targetStatus });
        if (perTaskRetro || globalAll) {
          // Force evaluation regardless of error/retry signals
          _evalFn(evalId).catch(err => log.error('Retro evaluation (forced) failed', { taskId, error: String(err) }));
        } else {
          // Standard signal-based evaluation
          _evalFn(evalId).catch(err => log.error('Retro evaluation failed', { taskId, error: String(err) }));
        }
      }

      json(res, 200, withTimestamp(mappedUpdated));
      return true;
    }

    return false;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'Request body too large') {
        json(res, 413, withTimestamp({ error: 'Request body too large' }));
        return true;
      }
      if (err.message === 'Invalid JSON') {
        json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
        return true;
      }
    }
    throw err;
  }
}
