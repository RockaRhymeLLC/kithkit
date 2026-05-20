/**
 * Unified Tasks API — canonical CRUD for the tasks table.
 *
 * Routes: /api/tasks (collection + item) + sub-routes
 * Both integer `id` and UUID `external_id` accepted in path params.
 * State machine transitions validated; side effects applied automatically.
 *
 * @deprecated-notice: none — this IS the canonical endpoint.
 * /api/todos and /api/orchestrator/tasks are deprecated shims.
 */

import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { json, withTimestamp, parseBody } from './helpers.js';
import { query, exec, get, getDatabase } from '../core/db.js';
import { injectMessage } from '../agents/tmux.js';
import { createLogger } from '../core/logger.js';
import { storeMemoryInternal } from './memory.js';
import { evaluateTask as _evaluateTask } from '../self-improvement/retro-evaluator.js';
import {
  validateTransition,
  allowedTransitions,
  getTransitionSideEffects,
  normalizeStatusAlias,
  VALID_STATUSES,
  TERMINAL_STATUSES,
} from '../core/task-state-machine.js';
import type { TaskStatus } from '../core/task-state-machine.js';

// Injectable for testing
let _evalFn: (taskId: string) => Promise<void> = _evaluateTask;
export function _setEvaluateTaskFnForTesting(fn: ((taskId: string) => Promise<void>) | null): void {
  _evalFn = fn ?? _evaluateTask;
}

const log = createLogger('unified-tasks');

// ── Types ─────────────────────────────────────────────────────

type TaskKind = 'todo' | 'orchestrator';
type ActivityType = 'progress' | 'note';
type PlanStatus = 'submitted' | 'approved' | 'rejected';
type OutcomeValue = 'success' | 'partial' | 'failed' | 'unknown';
type CommsOutcome = 'accepted' | 'corrected' | 'redirected' | 'cancelled';
type Priority = 'low' | 'medium' | 'high' | 'urgent';

interface UnifiedTask {
  id: number;
  external_id: string | null;
  kind: TaskKind;
  title: string;
  description: string | null;
  category: string | null;
  source: string | null;
  tags: string;
  parent_id: number | null;
  assigned_to: string | null;
  priority: Priority;
  status: TaskStatus;
  due_date: string | null;
  snooze_until: string | null;
  plan: string | null;
  plan_status: PlanStatus | null;
  plan_submitted_at: string | null;
  plan_approved_at: string | null;
  plan_rejected_reason: string | null;
  result: string | null;
  error: string | null;
  work_notes: string | null;
  retry_count: number;
  timeout_seconds: number | null;
  outcome: OutcomeValue | null;
  outcome_reason: string | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  calibration_mult: number | null;
  schedule_cron: string | null;
  schedule_interval_seconds: number | null;
  next_fire_at: string | null;
  is_recurring_parent: number;
  parent_recurring_id: number | null;
  complexity: number | null;
  risk: number | null;
  last_retry_reason: string | null;
  notify_policy: string | null;
  subscribed_agents: string;
  memory_ids: string;
  linked_artifacts: string;
  task_type: string | null;
  completion_status: string | null;
  estimation_method: string | null;
  workers_used: number | null;
  generate_retro: number | null;
  canonical_task_external_id: string | null;
  acknowledged_at: string | null;
  comms_outcome: CommsOutcome | null;
  comms_corrections: string | null;
  requesting_peer: string | null;
  created_at: string;
  updated_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
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

interface TaskAction {
  id: number;
  task_id: number;
  action: string;
  old_value: string | null;
  new_value: string | null;
  note: string | null;
  actor: string | null;
  created_at: string;
}

// ── Constants ─────────────────────────────────────────────────

const VALID_KINDS: readonly TaskKind[] = ['todo', 'orchestrator'];
const VALID_PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'urgent'];
const VALID_ACTIVITY_TYPES: readonly ActivityType[] = ['progress', 'note'];
const VALID_OUTCOMES: readonly OutcomeValue[] = ['success', 'partial', 'failed', 'unknown'];
const VALID_COMMS_OUTCOMES: readonly CommsOutcome[] = ['accepted', 'corrected', 'redirected', 'cancelled'];
const VALID_LAST_RETRY_REASONS = [
  'timeout', 'worker_error', 'cancelled', 'transient_failure',
  'plan_rejected', 'peer_unreachable',
] as const;

// UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Helpers ───────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

/**
 * Serialize a DB task row for API responses.
 * Adds computed fields that are not stored in the database.
 * - estimate_multiplier: actual_minutes / estimated_minutes, null when either is null or estimated_minutes is 0.
 */
function serializeTask(task: UnifiedTask): UnifiedTask & { estimate_multiplier: number | null } {
  const estimate_multiplier =
    task.actual_minutes !== null && task.estimated_minutes !== null && task.estimated_minutes !== 0
      ? task.actual_minutes / task.estimated_minutes
      : null;
  return { ...task, estimate_multiplier };
}

/**
 * Resolve a task by integer id or UUID external_id.
 * Tries integer parse first; falls back to UUID lookup.
 */
function resolveTask(id: string): UnifiedTask | undefined {
  const asInt = parseInt(id, 10);
  if (!isNaN(asInt) && String(asInt) === id) {
    return get<UnifiedTask>('tasks', asInt);
  }
  // UUID lookup
  const rows = query<UnifiedTask>('SELECT * FROM tasks WHERE external_id = ?', id);
  return rows[0];
}

function getTaskWorkers(taskId: number): TaskWorker[] {
  return query<TaskWorker>(
    'SELECT * FROM task_workers WHERE task_id = ? ORDER BY assigned_at ASC',
    taskId,
  );
}

function getTaskActivity(
  taskId: number,
  limit = 50,
  offset = 0,
): { data: TaskActivity[]; total: number } {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const safeOffset = Math.max(0, offset);

  const countRow = query<{ count: number }>(
    'SELECT COUNT(*) as count FROM task_activity WHERE task_id = ?',
    taskId,
  );
  const total = countRow[0]?.count ?? 0;

  const data = query<TaskActivity>(
    'SELECT * FROM task_activity WHERE task_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    taskId, safeLimit, safeOffset,
  );

  return { data, total };
}

function getTaskActions(taskId: number): TaskAction[] {
  return query<TaskAction>(
    'SELECT * FROM task_actions WHERE task_id = ? ORDER BY created_at ASC',
    taskId,
  );
}

function extractTaskId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)/);
  return match ? match[1]! : null;
}

// ── Route handler ─────────────────────────────────────────────

export async function handleUnifiedTasksRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (!pathname.startsWith('/api/tasks')) return false;

  try {
    // POST /api/tasks — create a task
    if (pathname === '/api/tasks' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
        json(res, 400, withTimestamp({ error: 'title is required' }));
        return true;
      }

      const kind: TaskKind = typeof body.kind === 'string' && VALID_KINDS.includes(body.kind as TaskKind)
        ? (body.kind as TaskKind)
        : 'todo';

      const priority: Priority = typeof body.priority === 'string' && VALID_PRIORITIES.includes(body.priority as Priority)
        ? (body.priority as Priority)
        : 'medium';

      // Generate external_id for orchestrator tasks; null for todos
      const externalId = kind === 'orchestrator'
        ? (typeof body.external_id === 'string' && UUID_RE.test(body.external_id)
          ? body.external_id
          : randomUUID())
        : null;

      const desc = typeof body.description === 'string' ? body.description : null;
      const source = typeof body.source === 'string' ? body.source : null;
      const category = typeof body.category === 'string' ? body.category : null;
      const tags = Array.isArray(body.tags) ? JSON.stringify(body.tags) : '[]';
      const assignedTo = typeof body.assigned_to === 'string' ? body.assigned_to : null;
      const dueDate = typeof body.due_date === 'string' ? body.due_date : null;
      const workNotes = typeof body.work_notes === 'string' ? body.work_notes : null;
      const timeout = typeof body.timeout_seconds === 'number' ? body.timeout_seconds : null;

      // complexity: 1-5 integer
      let complexity: number | null = null;
      if (typeof body.complexity === 'number' && body.complexity >= 1 && body.complexity <= 5) {
        complexity = body.complexity;
      }

      // parent_id
      const parentId = typeof body.parent_id === 'number' ? body.parent_id : null;

      // canonical_task_external_id (hex UUID, no dashes)
      const canonicalId = typeof body.canonical_task_external_id === 'string'
        ? body.canonical_task_external_id
        : null;

      // requesting_peer: lowercase alphanumeric/dash/underscore, 1..64 chars
      let requestingPeer: string | null = null;
      if (typeof body.requesting_peer === 'string') {
        const trimmed = body.requesting_peer.trim().toLowerCase();
        if (trimmed.length >= 1 && trimmed.length <= 64 && /^[a-z0-9_-]+$/.test(trimmed)) {
          requestingPeer = trimmed;
        }
      }

      const ts = now();

      exec(
        `INSERT INTO tasks (
          external_id, kind, title, description, source, category, tags,
          parent_id, assigned_to, priority, status,
          due_date, work_notes, timeout_seconds, complexity,
          canonical_task_external_id, requesting_peer,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        externalId,
        kind,
        body.title.trim(),
        desc,
        source,
        category,
        tags,
        parentId,
        assignedTo,
        priority,
        dueDate,
        workNotes,
        timeout,
        complexity,
        canonicalId,
        requestingPeer,
        ts,
        ts,
      );

      const rowid = query<{ id: number }>(
        'SELECT id FROM tasks WHERE created_at = ? AND title = ? ORDER BY id DESC LIMIT 1',
        ts, body.title.trim(),
      )[0];

      if (!rowid) {
        json(res, 500, withTimestamp({ error: 'Failed to create task' }));
        return true;
      }

      const task = get<UnifiedTask>('tasks', rowid.id)!;
      log.info('Task created', { id: task.id, external_id: task.external_id, kind, title: task.title });
      json(res, 201, withTimestamp(serializeTask(task)));
      return true;
    }

    // GET /api/tasks — list tasks
    if (pathname === '/api/tasks' && method === 'GET') {
      const statusFilter = searchParams.get('status');
      const kindFilter = searchParams.get('kind');
      const assignedToFilter = searchParams.get('assigned_to');
      const parentIdFilter = searchParams.get('parent_id');

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (statusFilter) {
        const statuses = statusFilter.split(',').map(s => s.trim());
        const invalid = statuses.filter(s => !VALID_STATUSES.includes(s as TaskStatus));
        if (invalid.length > 0) {
          json(res, 400, withTimestamp({ error: `invalid status filter: ${invalid.join(', ')}` }));
          return true;
        }
        const placeholders = statuses.map(() => '?').join(',');
        conditions.push(`status IN (${placeholders})`);
        params.push(...statuses);
      } else {
        // Default: exclude terminal statuses to avoid noise, but allow explicit override
        // No default filter — show everything (caller decides)
      }

      if (kindFilter) {
        if (!VALID_KINDS.includes(kindFilter as TaskKind)) {
          json(res, 400, withTimestamp({ error: `invalid kind filter: ${kindFilter}` }));
          return true;
        }
        conditions.push('kind = ?');
        params.push(kindFilter);
      }

      if (assignedToFilter) {
        conditions.push('assigned_to = ?');
        params.push(assignedToFilter);
      }

      if (parentIdFilter !== null) {
        const pid = parseInt(parentIdFilter, 10);
        if (isNaN(pid)) {
          json(res, 400, withTimestamp({ error: 'parent_id must be an integer' }));
          return true;
        }
        conditions.push('parent_id = ?');
        params.push(pid);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const tasks = query<UnifiedTask>(
        `SELECT * FROM tasks ${where} ORDER BY
           CASE priority
             WHEN 'urgent' THEN 1
             WHEN 'high'   THEN 2
             WHEN 'medium' THEN 3
             WHEN 'low'    THEN 4
             ELSE               5
           END ASC,
           created_at ASC`,
        ...params,
      );

      // Attach worker count and latest activity to each task
      const enriched = tasks.map(task => {
        const workers = getTaskWorkers(task.id);
        const latestActivity = query<TaskActivity>(
          'SELECT * FROM task_activity WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
          task.id,
        );
        return {
          ...serializeTask(task),
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

    // Check for sub-routes
    const subpath = pathname.slice(`/api/tasks/${taskId}`.length);

    // GET /api/tasks/:id/activity
    if (subpath === '/activity' && method === 'GET') {
      const task = resolveTask(taskId);
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

    // POST /api/tasks/:id/activity
    if (subpath === '/activity' && method === 'POST') {
      const task = resolveTask(taskId);
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

      // For progress updates, forward to comms immediately
      if (type === 'progress') {
        const prefix = stage ? `${stage}: ` : '';
        injectMessage('comms', `[task ${task.title}] ${prefix}${body.message}`);
      }

      const entry = query<TaskActivity>(
        'SELECT * FROM task_activity WHERE task_id = ? ORDER BY id DESC LIMIT 1',
        task.id,
      );

      log.info('Activity posted', { taskId: task.id, type, agent });
      json(res, 201, withTimestamp(entry[0]!));
      return true;
    }

    // GET /api/tasks/:id/workers
    if (subpath === '/workers' && method === 'GET') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const workers = getTaskWorkers(task.id);
      json(res, 200, withTimestamp({ data: workers }));
      return true;
    }

    // POST /api/tasks/:id/workers
    if (subpath === '/workers' && method === 'POST') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (TERMINAL_STATUSES.includes(task.status)) {
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

      log.info('Worker assigned to task', { taskId: task.id, workerId: body.worker_id, role });
      json(res, 201, withTimestamp({ task_id: task.id, worker_id: body.worker_id, role, assigned_at: ts }));
      return true;
    }

    // GET /api/tasks/:id/actions
    if (subpath === '/actions' && method === 'GET') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const actions = getTaskActions(task.id);
      json(res, 200, withTimestamp({ data: actions }));
      return true;
    }

    // GET /api/tasks/:id/subtasks
    if (subpath === '/subtasks' && method === 'GET') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const subtasks = query<UnifiedTask>(
        'SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC',
        task.id,
      );
      json(res, 200, withTimestamp({ data: subtasks }));
      return true;
    }

    // POST /api/tasks/:id/submit-plan
    if (subpath === '/submit-plan' && method === 'POST') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (task.status !== 'in_progress' && task.status !== 'planning') {
        json(res, 409, withTimestamp({
          error: `Can only submit a plan for in_progress or planning tasks, current status: ${task.status}`,
        }));
        return true;
      }

      const body = await parseBody(req);

      if (!body.plan || typeof body.plan !== 'string') {
        json(res, 400, withTimestamp({ error: 'plan is required and must be a string' }));
        return true;
      }

      const ts = now();

      getDatabase().transaction(() => {
        exec(
          `UPDATE tasks SET plan = ?, plan_status = 'submitted', plan_submitted_at = ?,
           status = 'awaiting_approval', updated_at = ? WHERE id = ?`,
          body.plan, ts, ts, task.id,
        );

        exec(
          `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'orchestrator', 'note', 'plan_submitted', 'Plan submitted for human approval', ?)`,
          task.id, ts,
        );
      })();

      // Notify comms
      const planPreview = (body.plan as string).slice(0, 500);
      const notifyBody = `[plan approval needed] Task "${task.title.slice(0, 80)}" has submitted a plan for review.\n\nPlan:\n${planPreview}${(body.plan as string).length > 500 ? '\n...(truncated)' : ''}\n\nApprove: curl -s -X POST 'http://localhost:3847/api/tasks/${task.id}/approve-plan' -H 'Content-Type: application/json' -d '{}'\nReject: curl -s -X POST 'http://localhost:3847/api/tasks/${task.id}/reject-plan' -H 'Content-Type: application/json' -d '{"reason":"..."}'`;

      try {
        exec(
          `INSERT INTO messages (from_agent, to_agent, type, body, created_at) VALUES ('daemon', 'comms', 'task', ?, ?)`,
          notifyBody, ts,
        );
      } catch (err) {
        log.warn('Failed to insert plan approval message to comms', { taskId: task.id, error: String(err) });
      }

      try {
        injectMessage('comms', notifyBody);
      } catch (e) {
        log.warn('Failed to inject plan submission notification to comms', { taskId: task.id, error: String(e) });
      }

      const updated = resolveTask(String(task.id))!;
      log.info('Plan submitted for approval', { taskId: task.id, title: task.title });
      json(res, 200, withTimestamp(serializeTask(updated)));
      return true;
    }

    // POST /api/tasks/:id/approve-plan
    if (subpath === '/approve-plan' && method === 'POST') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (task.status !== 'awaiting_approval') {
        json(res, 409, withTimestamp({
          error: `Can only approve plans for awaiting_approval tasks, current status: ${task.status}`,
        }));
        return true;
      }

      if (task.plan_status !== 'submitted') {
        json(res, 409, withTimestamp({
          error: `Can only approve tasks with plan_status=submitted, current plan_status: ${task.plan_status}`,
        }));
        return true;
      }

      const ts = now();

      getDatabase().transaction(() => {
        exec(
          `UPDATE tasks SET plan_status = 'approved', plan_approved_at = ?,
           status = 'in_progress', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
          ts, ts, ts, task.id,
        );

        exec(
          `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'daemon', 'note', 'plan_approved', 'Plan approved — resuming execution', ?)`,
          task.id, ts,
        );
      })();

      // Notify orchestrator
      const approveMsg = `[System] Plan approved for task ${task.id}${task.external_id ? ` (${task.external_id})` : ''}. Resume execution.`;
      try {
        exec(
          `INSERT INTO messages (from_agent, to_agent, type, body, created_at) VALUES ('daemon', 'orchestrator', 'task', ?, ?)`,
          approveMsg, ts,
        );
      } catch (err) {
        log.warn('Failed to insert plan approval notification to orchestrator', { taskId: task.id, error: String(err) });
      }

      try {
        injectMessage('orchestrator', approveMsg);
      } catch (e) {
        log.warn('Failed to inject plan approval notification to orchestrator', { taskId: task.id, error: String(e) });
      }

      const updated = resolveTask(String(task.id))!;
      log.info('Plan approved', { taskId: task.id, title: task.title });
      json(res, 200, withTimestamp(serializeTask(updated)));
      return true;
    }

    // POST /api/tasks/:id/reject-plan
    if (subpath === '/reject-plan' && method === 'POST') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (task.status !== 'awaiting_approval') {
        json(res, 409, withTimestamp({
          error: `Can only reject plans for awaiting_approval tasks, current status: ${task.status}`,
        }));
        return true;
      }

      if (task.plan_status !== 'submitted') {
        json(res, 409, withTimestamp({
          error: `Can only reject tasks with plan_status=submitted, current plan_status: ${task.plan_status}`,
        }));
        return true;
      }

      const body = await parseBody(req);
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'No reason provided';

      const ts = now();

      getDatabase().transaction(() => {
        exec(
          `UPDATE tasks SET plan_status = 'rejected', plan_rejected_reason = ?,
           status = 'planning', updated_at = ? WHERE id = ?`,
          reason, ts, task.id,
        );

        exec(
          `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'daemon', 'note', 'plan_rejected', ?, ?)`,
          task.id, `Plan rejected. Reason: ${reason}`, ts,
        );
      })();

      // Notify orchestrator
      const rejectMsg = `[System] Plan rejected for task ${task.id}${task.external_id ? ` (${task.external_id})` : ''}. Reason: ${reason}. Revise and resubmit.`;
      try {
        exec(
          `INSERT INTO messages (from_agent, to_agent, type, body, created_at) VALUES ('daemon', 'orchestrator', 'task', ?, ?)`,
          rejectMsg, ts,
        );
      } catch (err) {
        log.warn('Failed to insert plan rejection notification to orchestrator', { taskId: task.id, error: String(err) });
      }

      try {
        injectMessage('orchestrator', rejectMsg);
      } catch (e) {
        log.warn('Failed to inject plan rejection notification to orchestrator', { taskId: task.id, error: String(e) });
      }

      const updated = resolveTask(String(task.id))!;
      log.info('Plan rejected', { taskId: task.id, title: task.title, reason });
      json(res, 200, withTimestamp(serializeTask(updated)));
      return true;
    }

    // POST /api/tasks/:id/retry
    if (subpath === '/retry' && method === 'POST') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (task.status !== 'failed') {
        json(res, 409, withTimestamp({ error: `Can only retry failed tasks, current status: ${task.status}` }));
        return true;
      }

      const body = await parseBody(req);
      const ts = now();
      const newRetryCount = (task.retry_count ?? 0) + 1;

      const lastRetryReason = typeof body.reason === 'string'
        && VALID_LAST_RETRY_REASONS.includes(body.reason as typeof VALID_LAST_RETRY_REASONS[number])
        ? body.reason
        : null;

      exec(
        `UPDATE tasks SET status = 'pending', assigned_to = NULL, error = NULL, result = NULL,
         retry_count = ?, completed_at = NULL, last_retry_reason = ?, updated_at = ? WHERE id = ?`,
        newRetryCount, lastRetryReason, ts, task.id,
      );

      exec(
        `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
         VALUES (?, 'daemon', 'note', 'retry', ?, ?)`,
        task.id, `Task retried (attempt ${newRetryCount + 1})`, ts,
      );

      // Alert comms after 2 consecutive failures
      if (newRetryCount >= 2) {
        injectMessage('comms', `[task alert] "${task.title}" has failed ${newRetryCount} times and is being retried (attempt ${newRetryCount + 1})`);
      }

      const updated = resolveTask(String(task.id))!;
      log.info('Task retried', { id: task.id, retry_count: newRetryCount });
      json(res, 200, withTimestamp(serializeTask(updated)));
      return true;
    }

    // POST /api/tasks/:id/cancel
    if (subpath === '/cancel' && method === 'POST') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      if (TERMINAL_STATUSES.includes(task.status)) {
        json(res, 409, withTimestamp({ error: `Cannot cancel ${task.status} task` }));
        return true;
      }

      const ts = now();

      // If in_progress or blocked, kill assigned workers
      if (task.status === 'in_progress' || task.status === 'blocked') {
        const workers = getTaskWorkers(task.id);
        for (const w of workers) {
          try {
            exec(
              `UPDATE worker_jobs SET status = 'failed', error = 'parent task cancelled', finished_at = ?
               WHERE id = ? AND status IN ('queued', 'running')`,
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

      exec(
        `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
         VALUES (?, 'daemon', 'note', 'cancelled', 'Task cancelled', ?)`,
        task.id, ts,
      );

      // Auto-notify comms
      const msgBody = `Task cancelled: ${task.title}`;
      try {
        exec(
          `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
           VALUES ('daemon', 'comms', 'result', ?, ?)`,
          msgBody, ts,
        );
      } catch (err) {
        log.warn('Failed to auto-notify comms of cancellation', { taskId: task.id, error: String(err) });
      }

      injectMessage('comms', `[task cancelled] ${task.title.slice(0, 100)}`);

      const updated = resolveTask(String(task.id))!;
      log.info('Task cancelled', { id: task.id, previous_status: task.status });
      json(res, 200, withTimestamp(serializeTask(updated)));
      return true;
    }

    // GET /api/tasks/:id — get task detail
    if (!subpath && method === 'GET') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const workers = getTaskWorkers(task.id);
      const activity = getTaskActivity(task.id);
      const actions = getTaskActions(task.id);

      json(res, 200, withTimestamp({
        ...serializeTask(task),
        workers,
        activity: activity.data,
        activity_total: activity.total,
        actions,
      }));
      return true;
    }

    // DELETE /api/tasks/:id
    if (!subpath && method === 'DELETE') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      exec('DELETE FROM tasks WHERE id = ?', task.id);
      log.info('Task deleted', { id: task.id, title: task.title });
      json(res, 200, withTimestamp({ deleted: true, id: task.id }));
      return true;
    }

    // PUT /api/tasks/:id — update task
    if (!subpath && method === 'PUT') {
      const task = resolveTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      // Warn when an integer path param resolves to a kind='todo' row via the shared
      // auto-increment tasks.id PK.  Callers intending to update a specific todo by
      // its legacy display-id should use /api/todos/:id (the shim), which resolves
      // by external_id + kind='todo' and is immune to PK collision.  Direct integer
      // lookups on /api/tasks mutate whatever row occupies that PK slot — which may
      // be a migrated todo whose display-id is completely different.
      const _taskIdAsInt = parseInt(taskId, 10);
      if (!isNaN(_taskIdAsInt) && String(_taskIdAsInt) === taskId && task.kind === 'todo') {
        log.warn(
          `PUT /api/tasks/:id resolved to a kind="todo" row (id=${task.id}). ` +
          'Callers updating todos should use /api/todos/:id; raw /api/tasks/:id mutates by ' +
          'internal PK which may collide with todo display ids. See kithkit-internal #1812.',
        );
      }

      const body = await parseBody(req);

      // Classify what's being updated
      const hasCommsFeedback = body.comms_outcome !== undefined
        || body.comms_corrections !== undefined
        || body.acknowledged_at !== undefined;

      const hasNonFeedbackFields = body.status !== undefined
        || body.assigned_to !== undefined
        || body.result !== undefined
        || body.error !== undefined
        || body.work_notes !== undefined
        || body.outcome !== undefined
        || body.outcome_reason !== undefined
        || body.plan !== undefined
        || body.title !== undefined
        || body.description !== undefined
        || body.priority !== undefined
        || body.due_date !== undefined
        || body.snooze_until !== undefined
        || body.tags !== undefined
        || body.category !== undefined;

      // Guard: acknowledged_at can only be set on terminal tasks
      if (body.acknowledged_at !== undefined && !TERMINAL_STATUSES.includes(task.status)) {
        json(res, 409, withTimestamp({ error: 'acknowledged_at can only be set on terminal tasks (completed/failed/abandoned/cancelled)' }));
        return true;
      }

      // Guard: only comms may set acknowledged_at on source='human' tasks
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

      // Terminal tasks block non-feedback updates
      if (TERMINAL_STATUSES.includes(task.status)) {
        if (hasNonFeedbackFields || !hasCommsFeedback) {
          json(res, 409, withTimestamp({ error: `Cannot update ${task.status} task` }));
          return true;
        }
        // Comms-feedback-only update on terminal task — fall through
      }

      const ts = now();
      const updates: Record<string, unknown> = { updated_at: ts };

      let targetStatus = task.status;

      // ── Status transition ──────────────────────────────────
      if (body.status !== undefined) {
        body.status = normalizeStatusAlias(body.status);
        const newStatus = body.status as TaskStatus;
        if (!VALID_STATUSES.includes(newStatus)) {
          json(res, 400, withTimestamp({ error: `invalid status: ${body.status}` }));
          return true;
        }

        // Todo tasks bypass the orchestrator state machine — any valid status is permitted
        // (mirrors the /api/todos shim behaviour which has no transition enforcement).
        // Orchestrator tasks remain strictly gated.
        if (task.kind !== 'todo' && !validateTransition(task.status, newStatus)) {
          json(res, 422, withTimestamp({
            error: `cannot transition from ${task.status} to ${newStatus}`,
            allowed_transitions: allowedTransitions(task.status),
          }));
          return true;
        }

        targetStatus = newStatus;
        updates.status = newStatus;

        // Apply state machine side effects
        const effects = getTransitionSideEffects(task.status, newStatus, {
          assigned_at: task.assigned_at,
          started_at: task.started_at,
          completed_at: task.completed_at,
        }, ts);

        if (effects.assigned_at) updates.assigned_at = effects.assigned_at;
        if (effects.started_at) updates.started_at = effects.started_at;
        if (effects.completed_at) updates.completed_at = effects.completed_at;
        if (effects.plan_submitted_at) updates.plan_submitted_at = effects.plan_submitted_at;
        if (effects.plan_approved_at) updates.plan_approved_at = effects.plan_approved_at;

        // Transitioning to pending clears assigned_to
        if (newStatus === 'pending') {
          updates.assigned_to = null;
        }
      }

      // ── Core fields ────────────────────────────────────────
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim()) {
          json(res, 400, withTimestamp({ error: 'title must be a non-empty string' }));
          return true;
        }
        updates.title = body.title.trim();
      }

      if (body.description !== undefined) {
        updates.description = typeof body.description === 'string' ? body.description : null;
      }

      if (body.category !== undefined) {
        updates.category = typeof body.category === 'string' ? body.category : null;
      }

      if (body.tags !== undefined) {
        updates.tags = Array.isArray(body.tags) ? JSON.stringify(body.tags) : '[]';
      }

      if (body.priority !== undefined) {
        if (!VALID_PRIORITIES.includes(body.priority as Priority)) {
          json(res, 400, withTimestamp({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` }));
          return true;
        }
        updates.priority = body.priority;
      }

      if (body.due_date !== undefined) {
        updates.due_date = typeof body.due_date === 'string' ? body.due_date : null;
      }

      if (body.snooze_until !== undefined) {
        updates.snooze_until = typeof body.snooze_until === 'string' ? body.snooze_until : null;
      }

      if (body.assigned_to !== undefined && updates.assigned_to === undefined) {
        updates.assigned_to = typeof body.assigned_to === 'string' ? body.assigned_to : null;
        // If assigning for the first time, stamp assigned_at
        if (body.assigned_to && !task.assigned_at && !updates.assigned_at) {
          updates.assigned_at = ts;
        }
      }

      // ── Execution fields ───────────────────────────────────
      if (body.result !== undefined) {
        updates.result = typeof body.result === 'string' ? body.result : null;
      }

      if (body.error !== undefined) {
        updates.error = typeof body.error === 'string' ? body.error : null;
      }

      if (body.work_notes !== undefined) {
        if (body.append_work_notes) {
          const ts_note = new Date().toISOString().slice(0, 19).replace('T', ' ');
          if (task.work_notes) {
            updates.work_notes = `${task.work_notes}\n\n[${ts_note}] ${body.work_notes}`;
          } else {
            updates.work_notes = `[${ts_note}] ${body.work_notes}`;
          }
        } else {
          updates.work_notes = typeof body.work_notes === 'string' ? body.work_notes : null;
        }
      }

      if (body.outcome !== undefined) {
        if (body.outcome !== null && !VALID_OUTCOMES.includes(body.outcome as OutcomeValue)) {
          json(res, 400, withTimestamp({ error: `outcome must be one of: ${VALID_OUTCOMES.join(', ')}` }));
          return true;
        }
        updates.outcome = body.outcome ?? null;
      }

      if (body.outcome_reason !== undefined) {
        updates.outcome_reason = typeof body.outcome_reason === 'string' ? body.outcome_reason : null;
      }

      // ── Plan mutation guard ────────────────────────────────
      if (body.plan !== undefined) {
        if (task.plan_status === 'submitted') {
          json(res, 409, withTimestamp({ error: 'Cannot modify plan while awaiting approval. Reject the current plan first.' }));
          return true;
        }
        updates.plan = typeof body.plan === 'string' ? body.plan : null;
      }

      // ── Calibration / estimation fields ───────────────────
      if (body.complexity !== undefined) {
        if (body.complexity !== null
          && (typeof body.complexity !== 'number' || body.complexity < 1 || body.complexity > 5)) {
          json(res, 400, withTimestamp({ error: 'complexity must be an integer 1-5 or null' }));
          return true;
        }
        updates.complexity = body.complexity ?? null;
      }

      if (body.risk !== undefined) {
        if (body.risk !== null
          && (typeof body.risk !== 'number' || body.risk < 1 || body.risk > 5)) {
          json(res, 400, withTimestamp({ error: 'risk must be an integer 1-5 or null' }));
          return true;
        }
        updates.risk = body.risk ?? null;
      }

      if (body.estimated_minutes !== undefined) {
        updates.estimated_minutes = typeof body.estimated_minutes === 'number' ? body.estimated_minutes : null;
      }

      if (body.actual_minutes !== undefined) {
        updates.actual_minutes = typeof body.actual_minutes === 'number' ? body.actual_minutes : null;
      }

      // Recompute calibration_mult if both values are now available
      const finalEstimated = (updates.estimated_minutes !== undefined
        ? (updates.estimated_minutes as number | null)
        : task.estimated_minutes);
      const finalActual = (updates.actual_minutes !== undefined
        ? (updates.actual_minutes as number | null)
        : task.actual_minutes);
      if (finalEstimated && finalActual && finalEstimated > 0) {
        updates.calibration_mult = finalActual / finalEstimated;
      }

      if (body.task_type !== undefined) {
        updates.task_type = typeof body.task_type === 'string' ? body.task_type : null;
      }

      if (body.completion_status !== undefined) {
        updates.completion_status = typeof body.completion_status === 'string' ? body.completion_status : null;
      }

      if (body.estimation_method !== undefined) {
        updates.estimation_method = typeof body.estimation_method === 'string' ? body.estimation_method : null;
      }

      if (body.workers_used !== undefined) {
        updates.workers_used = typeof body.workers_used === 'number' ? body.workers_used : null;
      }

      // ── Retro / cross-machine sync ─────────────────────────
      if (body.generate_retro !== undefined) {
        updates.generate_retro = body.generate_retro === null ? null : (body.generate_retro ? 1 : 0);
      }

      if (body.canonical_task_external_id !== undefined) {
        updates.canonical_task_external_id = typeof body.canonical_task_external_id === 'string'
          ? body.canonical_task_external_id
          : null;
      }

      // ── Comms feedback fields (revisable on terminal tasks) ─
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

      // ── Build and execute UPDATE ───────────────────────────
      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = Object.values(updates);
      exec(
        `UPDATE tasks SET ${setClauses} WHERE id = ?`,
        ...values, task.id,
      );

      // Auto-log activity on status change
      if (updates.status) {
        const activityMessage = updates.status === 'completed'
          ? `Status → completed. Result: ${(updates.result as string | undefined)?.slice(0, 200) ?? task.result?.slice(0, 200) ?? '(none)'}`
          : updates.status === 'failed'
            ? `Status → failed. Error: ${(updates.error as string | undefined)?.slice(0, 200) ?? task.error?.slice(0, 200) ?? '(none)'}`
            : `Status → ${updates.status}`;

        exec(
          `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'daemon', 'note', 'status_change', ?, ?)`,
          task.id, activityMessage, ts,
        );
      }

      const updated = resolveTask(String(task.id))!;
      log.info('Task updated', { id: task.id, status: updated.status, assigned_to: updated.assigned_to });

      // Auto-notify comms on terminal transition
      if (updates.status && TERMINAL_STATUSES.includes(targetStatus)) {
        const msgBody = targetStatus === 'completed'
          ? `Task completed: ${updated.title}\n\nResult: ${updated.result ?? '(no result provided)'}`
          : targetStatus === 'cancelled'
            ? `Task cancelled: ${updated.title}`
            : targetStatus === 'abandoned'
              ? `Task abandoned: ${updated.title}`
              : `Task failed: ${updated.title}\n\nError: ${updated.error ?? '(no error details)'}`;

        try {
          exec(
            `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
             VALUES ('daemon', 'comms', 'result', ?, ?)`,
            msgBody, new Date().toISOString(),
          );
          log.info('Auto-notified comms of task terminal state', { taskId: task.id, status: targetStatus });
        } catch (err) {
          log.warn('Failed to auto-notify comms', { taskId: task.id, error: String(err) });
        }

        injectMessage('comms', `[task ${targetStatus}] ${updated.title.slice(0, 100)}`);
      }

      // Auto-store completion memory
      if (updates.status === 'completed' && updated.result) {
        try {
          const title = updated.title.substring(0, 100);
          const result = updated.result.substring(0, 200);
          const content = `Completed task: ${title}. ${result}`;
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

      // Retro evaluation on terminal transitions (skip comms-feedback-only updates)
      if (updates.status && (targetStatus === 'completed' || targetStatus === 'failed')) {
        // Only evaluate orchestrator-kind tasks (they have external_id for retro-evaluator)
        if (updated.kind === 'orchestrator' && updated.external_id) {
          const { getSelfImprovementConfig: _getSIC } = await import('../self-improvement/config.js');
          const _sic = _getSIC();
          const perTaskRetro = updated.generate_retro === 1;
          const globalAll = _sic.retro.retro_all_terminal;
          if (perTaskRetro || globalAll) {
            _evalFn(updated.external_id).catch(err =>
              log.warn('Retro evaluation (forced) failed', { taskId: task.id, error: String(err) }),
            );
          } else {
            _evalFn(updated.external_id).catch(err =>
              log.warn('Retro evaluation failed', { taskId: task.id, error: String(err) }),
            );
          }
        }
      }

      json(res, 200, withTimestamp(serializeTask(updated)));
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
