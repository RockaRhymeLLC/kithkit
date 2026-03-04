/**
 * Task Queue API — structured task management for orchestrator work.
 *
 * State machine: pending → assigned → in_progress → completed/failed
 *
 * Routes:
 *   POST   /api/orchestrator/tasks              — Create a task
 *   GET    /api/orchestrator/tasks              — List tasks (filterable by status)
 *   GET    /api/orchestrator/tasks/:id          — Get task detail (+ workers + activity)
 *   PUT    /api/orchestrator/tasks/:id          — Update task (status, assignee, result)
 *   POST   /api/orchestrator/tasks/:id/activity — Post activity entry
 *   GET    /api/orchestrator/tasks/:id/activity — Get activity log (paginated)
 *   POST   /api/orchestrator/tasks/:id/workers  — Assign worker to task
 */

import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { json, withTimestamp, parseBody } from './helpers.js';
import { query, exec, get } from '../core/db.js';
import { injectMessage as _injectMessage } from '../agents/tmux.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('task-queue');

// ── Injectable dep (overridable for testing) ─────────────────
let injectMessage = _injectMessage;

/** @internal Override injectMessage for testing (prevents real tmux injection). */
export function _setInjectMessageForTesting(fn: typeof _injectMessage): void {
  injectMessage = fn;
}

/** @internal Reset injectMessage to real implementation. */
export function _resetInjectMessageForTesting(): void {
  injectMessage = _injectMessage;
}

// ── Types ────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
type ActivityType = 'progress' | 'note';

interface OrchestratorTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  priority: number;
  result: string | null;
  error: string | null;
  work_notes: string | null;
  timeout_seconds: number | null;
  created_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface TaskWorker {
  task_id: string;
  worker_id: string;
  role: string | null;
  assigned_at: string;
}

interface TaskActivity {
  id: number;
  task_id: string;
  agent: string;
  type: ActivityType;
  stage: string | null;
  message: string;
  created_at: string;
}

// ── Constants ────────────────────────────────────────────────

const VALID_STATUSES: readonly TaskStatus[] = ['pending', 'assigned', 'in_progress', 'completed', 'failed'];
const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed'];
const VALID_ACTIVITY_TYPES: readonly ActivityType[] = ['progress', 'note'];

/**
 * Valid status transitions. Key = current status, value = allowed next statuses.
 */
const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['assigned', 'failed'],
  assigned: ['in_progress', 'failed', 'pending'],
  in_progress: ['completed', 'failed'],
  completed: [],
  failed: [],
};

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

function getTask(id: string): OrchestratorTask | undefined {
  return get<OrchestratorTask>('orchestrator_tasks', id);
}

function getTaskWorkers(taskId: string): TaskWorker[] {
  return query<TaskWorker>(
    'SELECT * FROM orchestrator_task_workers WHERE task_id = ? ORDER BY assigned_at ASC',
    taskId,
  );
}

function getTaskActivity(taskId: string, limit = 50, offset = 0): { data: TaskActivity[]; total: number } {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const safeOffset = Math.max(0, offset);

  const countRow = query<{ count: number }>(
    'SELECT COUNT(*) as count FROM orchestrator_task_activity WHERE task_id = ?',
    taskId,
  );
  const total = countRow[0]?.count ?? 0;

  const data = query<TaskActivity>(
    'SELECT * FROM orchestrator_task_activity WHERE task_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    taskId, safeLimit, safeOffset,
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

      const id = randomUUID();
      const ts = now();

      exec(
        `INSERT INTO orchestrator_tasks (id, title, description, status, priority, work_notes, timeout_seconds, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        id,
        body.title,
        typeof body.description === 'string' ? body.description : null,
        priority,
        typeof body.work_notes === 'string' ? body.work_notes : null,
        typeof body.timeout_seconds === 'number' ? body.timeout_seconds : null,
        ts,
        ts,
      );

      const task = getTask(id)!;
      log.info('Task created', { id, title: task.title, priority });
      json(res, 201, withTimestamp(task));
      return true;
    }

    // GET /api/orchestrator/tasks — list tasks
    if (pathname === '/api/orchestrator/tasks' && method === 'GET') {
      const statusFilter = searchParams.get('status');
      let tasks: OrchestratorTask[];

      if (statusFilter) {
        const statuses = statusFilter.split(',').map(s => s.trim());
        const invalid = statuses.filter(s => !VALID_STATUSES.includes(s as TaskStatus));
        if (invalid.length > 0) {
          json(res, 400, withTimestamp({ error: `invalid status filter: ${invalid.join(', ')}` }));
          return true;
        }
        const placeholders = statuses.map(() => '?').join(',');
        tasks = query<OrchestratorTask>(
          `SELECT * FROM orchestrator_tasks WHERE status IN (${placeholders}) ORDER BY priority DESC, created_at ASC`,
          ...statuses,
        );
      } else {
        tasks = query<OrchestratorTask>(
          'SELECT * FROM orchestrator_tasks ORDER BY priority DESC, created_at ASC',
        );
      }

      // Attach latest activity and worker count to each task
      const enriched = tasks.map(task => {
        const workers = getTaskWorkers(task.id);
        const latestActivity = query<TaskActivity>(
          'SELECT * FROM orchestrator_task_activity WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
          task.id,
        );
        return {
          ...task,
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
      const result = getTaskActivity(taskId, isNaN(limit) ? 50 : limit, isNaN(offset) ? 0 : offset);

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
        `INSERT INTO orchestrator_task_activity (task_id, agent, type, stage, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        taskId, agent, type, stage, body.message, ts,
      );

      // For progress updates, forward to comms session immediately
      if (type === 'progress') {
        const prefix = stage ? `${stage}: ` : '';
        injectMessage('comms', `[task ${task.title}] ${prefix}${body.message}`);
      }

      const entry = query<TaskActivity>(
        'SELECT * FROM orchestrator_task_activity WHERE task_id = ? ORDER BY id DESC LIMIT 1',
        taskId,
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
          'INSERT INTO orchestrator_task_workers (task_id, worker_id, role, assigned_at) VALUES (?, ?, ?, ?)',
          taskId, body.worker_id, role, ts,
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
          json(res, 409, withTimestamp({ error: 'Worker already assigned to this task' }));
          return true;
        }
        throw err;
      }

      log.info('Worker assigned to task', { taskId, workerId: body.worker_id, role });
      json(res, 201, withTimestamp({ task_id: taskId, worker_id: body.worker_id, role, assigned_at: ts }));
      return true;
    }

    // GET /api/orchestrator/tasks/:id — get task detail
    if (!subpath && method === 'GET') {
      const task = getTask(taskId);
      if (!task) {
        json(res, 404, withTimestamp({ error: 'Task not found' }));
        return true;
      }

      const workers = getTaskWorkers(taskId);
      const activity = getTaskActivity(taskId);

      json(res, 200, withTimestamp({
        ...task,
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

      if (TERMINAL_STATUSES.includes(task.status as TaskStatus)) {
        json(res, 409, withTimestamp({ error: `Cannot update ${task.status} task` }));
        return true;
      }

      const body = await parseBody(req);
      const ts = now();
      const updates: Record<string, unknown> = { updated_at: ts };

      // Determine the target status and assignee
      let targetStatus = task.status as TaskStatus;
      let targetAssignee = task.assignee;

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
          updates.assignee = null;
        }
      }

      if (body.assignee !== undefined) {
        targetAssignee = body.assignee as string | null;
        updates.assignee = body.assignee;
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
        `UPDATE orchestrator_tasks SET ${setClauses} WHERE id = ?`,
        ...values, taskId,
      );

      // Fix 4: Auto-log activity on status change
      if (updates.status) {
        const activityMessage = updates.status === 'completed'
          ? `Status → completed. Result: ${(updates.result as string)?.slice(0, 200) ?? '(none)'}`
          : updates.status === 'failed'
            ? `Status → failed. Error: ${(updates.error as string)?.slice(0, 200) ?? '(none)'}`
            : `Status → ${updates.status}`;

        exec(
          `INSERT INTO orchestrator_task_activity (task_id, agent, type, stage, message, created_at)
           VALUES (?, 'daemon', 'note', 'status_change', ?, ?)`,
          taskId, activityMessage, ts,
        );
      }

      const updated = getTask(taskId)!;
      log.info('Task updated', { id: taskId, status: updated.status, assignee: updated.assignee });

      // Fix 2: Auto-notify comms on task completion/failure
      if (updates.status && TERMINAL_STATUSES.includes(updates.status as TaskStatus)) {
        const msgBody = updates.status === 'completed'
          ? `Task completed: ${updated.title}\n\nResult: ${updated.result ?? '(no result provided)'}`
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

      json(res, 200, withTimestamp(updated));
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
