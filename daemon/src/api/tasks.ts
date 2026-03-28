/**
 * Tasks API — list scheduled tasks, trigger runs, view history.
 *
 * Routes:
 *   GET  /api/tasks              — List all registered tasks with next run time
 *   POST /api/tasks/:name/run    — Manually trigger a task
 *   GET  /api/tasks/:name/history — Get execution history for a task
 *   POST   /api/tasks/:name/sleep  — Put task to sleep for N hours
 *   GET    /api/tasks/:name/sleep  — Get current sleep state (or null)
 *   DELETE /api/tasks/:name/sleep  — Cancel sleep (wake task)
 */

import type http from 'node:http';
import type { Scheduler } from '../automation/scheduler.js';
import { getTaskHistory } from '../automation/task-runner.js';
import { json, withTimestamp, parseBody } from './helpers.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tasks-api');

const MAX_SLEEP_HOURS = 4;

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
      lastRunAt: t.lastRunAt?.toISOString() ?? null,
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

  // Sleep endpoints: POST/GET/DELETE /api/tasks/:name/sleep
  const sleepMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/sleep$/);
  if (sleepMatch) {
    if (!_scheduler) {
      json(res, 503, withTimestamp({ error: 'Scheduler not initialized' }));
      return true;
    }

    const taskName = decodeURIComponent(sleepMatch[1]!);

    if (method === 'GET') {
      const task = _scheduler.getTask(taskName);
      if (!task) {
        json(res, 404, withTimestamp({ error: `Task not found: ${taskName}` }));
        return true;
      }
      const state = _scheduler.getTaskSleep(taskName);
      json(res, 200, withTimestamp({ task: taskName, sleep: state }));
      return true;
    }

    if (method === 'POST') {
      const task = _scheduler.getTask(taskName);
      if (!task) {
        json(res, 404, withTimestamp({ error: `Task not found: ${taskName}` }));
        return true;
      }
      const body = await parseBody(req);

      // Require a reason for sleeping — adds friction to discourage casual snoozing
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason || reason.length < 5) {
        json(res, 400, withTimestamp({
          error: 'reason is required (min 5 chars). Explain why you are snoozing this task.',
        }));
        return true;
      }

      const hours = typeof body.hours === 'number' ? body.hours : parseFloat(body.hours as string);
      if (isNaN(hours) || hours <= 0) {
        json(res, 400, withTimestamp({ error: 'hours must be a positive number' }));
        return true;
      }

      // Cap sleep duration at MAX_SLEEP_HOURS — forces agents to re-evaluate frequently
      const cappedHours = Math.min(hours, MAX_SLEEP_HOURS);
      if (hours > MAX_SLEEP_HOURS) {
        log.warn(`Sleep request for ${taskName} capped from ${hours}h to ${MAX_SLEEP_HOURS}h (reason: ${reason})`);
      }

      log.info(`Task ${taskName} put to sleep for ${cappedHours}h — reason: ${reason}`);
      const wakeAt = _scheduler.sleepTask(taskName, cappedHours);
      json(res, 200, withTimestamp({
        task: taskName,
        sleeping_until: wakeAt.toISOString(),
        hours_requested: hours,
        hours_granted: cappedHours,
        reason,
        ...(hours > MAX_SLEEP_HOURS ? { note: `Capped from ${hours}h to ${MAX_SLEEP_HOURS}h max` } : {}),
      }));
      return true;
    }

    if (method === 'DELETE') {
      const task = _scheduler.getTask(taskName);
      if (!task) {
        json(res, 404, withTimestamp({ error: `Task not found: ${taskName}` }));
        return true;
      }
      _scheduler.wakeTask(taskName);
      json(res, 200, withTimestamp({ task: taskName, sleep: null }));
      return true;
    }
  }

  return false;
}
