/**
 * Orchestrator Workers API — convenient worker management scoped to orchestrator tasks.
 *
 * Wraps /api/agents/ with automatic task linkage:
 *   POST   /api/orchestrator/workers/spawn    — Spawn worker + auto-link to task
 *   GET    /api/orchestrator/workers           — List workers (optionally by task_id)
 *   GET    /api/orchestrator/workers/:id       — Worker status
 *   DELETE /api/orchestrator/workers/:id       — Kill a worker
 */

import type http from 'node:http';
import { json, withTimestamp, parseBody } from './helpers.js';
import { spawnWorkerJob, getJobStatus, killJob } from '../agents/lifecycle.js';
import { loadProfiles } from '../agents/profiles.js';
import { exec, query } from '../core/db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('orchestrator-workers');

let profilesDir: string = '';

export function setProfilesDir(dir: string): void {
  profilesDir = dir;
}

interface WorkerJobRow {
  id: string;
  profile: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  spawned_by: string;
}

export async function handleOrchestratorWorkersRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (!pathname.startsWith('/api/orchestrator/workers')) return false;

  try {
    // POST /api/orchestrator/workers/spawn — spawn with auto task linkage
    if (pathname === '/api/orchestrator/workers/spawn' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.prompt || typeof body.prompt !== 'string') {
        json(res, 400, withTimestamp({ error: 'prompt is required' }));
        return true;
      }
      if (!body.profile || typeof body.profile !== 'string') {
        json(res, 400, withTimestamp({ error: 'profile is required' }));
        return true;
      }

      const taskId = typeof body.task_id === 'string' ? body.task_id : null;

      // Validate task exists if provided
      if (taskId) {
        const taskRow = query<{ id: string; status: string }>(
          'SELECT id, status FROM orchestrator_tasks WHERE id = ?', taskId,
        );
        if (taskRow.length === 0) {
          json(res, 404, withTimestamp({ error: `Task ${taskId} not found` }));
          return true;
        }
      }

      // Load and find profile
      const profiles = loadProfiles(profilesDir);
      const profile = profiles.get(body.profile as string);
      if (!profile) {
        json(res, 400, withTimestamp({ error: `Profile ${body.profile} not found` }));
        return true;
      }

      const result = spawnWorkerJob({
        profile,
        prompt: body.prompt as string,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        maxBudgetUsd: typeof body.maxBudgetUsd === 'number' ? body.maxBudgetUsd : undefined,
        spawned_by: 'orchestrator',
      });

      // Auto-link worker to task
      if (taskId) {
        const ts = new Date().toISOString();
        try {
          exec(
            'INSERT INTO orchestrator_task_workers (task_id, worker_id, role, assigned_at) VALUES (?, ?, ?, ?)',
            taskId, result.jobId, body.profile as string, ts,
          );
        } catch (err) {
          log.warn('Failed to link worker to task', { taskId, jobId: result.jobId, error: String(err) });
        }
      }

      log.info('Worker spawned via orchestrator API', { jobId: result.jobId, profile: body.profile, taskId });
      json(res, 202, withTimestamp({
        jobId: result.jobId,
        status: result.status,
        task_id: taskId,
      }));
      return true;
    }

    // GET /api/orchestrator/workers — list workers
    if (pathname === '/api/orchestrator/workers' && method === 'GET') {
      const taskId = searchParams.get('task_id');

      let workers: WorkerJobRow[];
      if (taskId) {
        // Workers linked to a specific task
        workers = query<WorkerJobRow>(
          `SELECT wj.id, wj.profile, wj.status, wj.started_at, wj.finished_at, wj.error, wj.spawned_by
           FROM worker_jobs wj
           JOIN orchestrator_task_workers tw ON wj.id = tw.worker_id
           WHERE tw.task_id = ?
           ORDER BY wj.started_at DESC`,
          taskId,
        );
      } else {
        // All workers spawned by orchestrator
        workers = query<WorkerJobRow>(
          `SELECT id, profile, status, started_at, finished_at, error, spawned_by
           FROM worker_jobs
           WHERE spawned_by = 'orchestrator'
           ORDER BY started_at DESC
           LIMIT 50`,
        );
      }

      json(res, 200, withTimestamp({ data: workers }));
      return true;
    }

    // Routes with worker ID
    const workerPrefix = '/api/orchestrator/workers/';
    if (pathname.startsWith(workerPrefix) && pathname !== '/api/orchestrator/workers/spawn') {
      const workerId = pathname.slice(workerPrefix.length);
      if (!workerId) return false;

      // GET /api/orchestrator/workers/:id — worker status
      if (method === 'GET') {
        const job = getJobStatus(workerId);
        if (!job) {
          json(res, 404, withTimestamp({ error: 'Worker not found' }));
          return true;
        }
        json(res, 200, withTimestamp(job));
        return true;
      }

      // DELETE /api/orchestrator/workers/:id — kill worker
      if (method === 'DELETE') {
        const killed = killJob(workerId);
        if (!killed) {
          json(res, 404, withTimestamp({ error: 'Worker not found or not running' }));
          return true;
        }
        log.info('Worker killed via orchestrator API', { workerId });
        json(res, 200, withTimestamp({ status: 'killed', worker_id: workerId }));
        return true;
      }
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
