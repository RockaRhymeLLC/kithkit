/**
 * Tasks API — list scheduled tasks, trigger runs, view history.
 *
 * Routes:
 *   GET  /api/tasks              — List all registered tasks with next run time
 *   POST /api/tasks/:name/run    — Manually trigger a task
 *   GET  /api/tasks/:name/history — Get execution history for a task
 */

import type http from 'node:http';
import type { Scheduler } from '../automation/scheduler.js';
import { getTaskHistory } from '../automation/task-runner.js';

// ── Helpers ──────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function withTimestamp<T extends object>(obj: T): T & { timestamp: string } {
  return { ...obj, timestamp: new Date().toISOString() };
}

// ── State ────────────────────────────────────────────────────

let _scheduler: Scheduler | null = null;

export function setScheduler(scheduler: Scheduler): void {
  _scheduler = scheduler;
}

export function _getSchedulerForTesting(): Scheduler | null {
  return _scheduler;
}

// ── Route handler ────────────────────────────────────────────

export async function handleTasksRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // GET /api/tasks — list all tasks
  if (pathname === '/api/tasks' && method === 'GET') {
    if (!_scheduler) {
      json(res, 200, withTimestamp({ data: [] }));
      return true;
    }

    const tasks = _scheduler.getTasks().map(t => ({
      name: t.name,
      enabled: t.enabled,
      schedule: t.schedule,
      running: t.running,
      nextRunAt: t.nextRunAt?.toISOString() ?? null,
      lastRunAt: t.lastRunAt ? new Date(t.lastRunAt as unknown as string).toISOString() : null,
    }));

    json(res, 200, withTimestamp({ data: tasks }));
    return true;
  }

  // POST /api/tasks/:name/run — manual trigger
  const runMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (runMatch && method === 'POST') {
    if (!_scheduler) {
      json(res, 503, withTimestamp({ error: 'Scheduler not initialized' }));
      return true;
    }

    const taskName = decodeURIComponent(runMatch[1]!);
    const task = _scheduler.getTask(taskName);

    if (!task) {
      json(res, 404, withTimestamp({ error: `Task not found: ${taskName}` }));
      return true;
    }

    try {
      const result = await _scheduler.triggerTask(taskName);
      json(res, 200, withTimestamp({ data: result }));
    } catch (err) {
      json(res, 500, withTimestamp({ error: String(err) }));
    }

    return true;
  }

  // GET /api/tasks/:name/history — task history
  const historyMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/history$/);
  if (historyMatch && method === 'GET') {
    const taskName = decodeURIComponent(historyMatch[1]!);
    const history = getTaskHistory(taskName);
    json(res, 200, withTimestamp({ data: history }));
    return true;
  }

  return false;
}
