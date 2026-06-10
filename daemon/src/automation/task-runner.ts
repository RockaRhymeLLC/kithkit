/**
 * Task runner — executes tasks as subprocesses and captures results.
 *
 * Tasks can be any executable: bash scripts, Python, TypeScript, `claude -p`, etc.
 * Output is captured (stdout + stderr merged) and stored with duration.
 */

import { execFile } from 'node:child_process';
import { exec as dbExec, query } from '../core/db.js';
import { createLogger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';

const log = createLogger('task-runner');

// ── Types ────────────────────────────────────────────────────

export interface TaskResult {
  id: number;
  task_name: string;
  status: 'success' | 'failure' | 'timeout';
  output: string | null;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
}

export interface RunOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
}

// ── Persistence ──────────────────────────────────────────────

/**
 * Insert a task result row and return the stored record.
 *
 * - Fetches the inserted row by lastInsertRowid (not "latest for task_name"),
 *   so concurrent runs of the same task can't read each other's rows.
 * - Never throws: a DB write failure must not leave runTask's promise
 *   pending forever (which would hang the scheduler). On failure, returns
 *   a synthetic result with id = -1 and logs the error.
 */
export function persistResult(
  taskName: string,
  status: TaskResult['status'],
  output: string | null,
  durationMs: number,
  startedAt: string,
  finishedAt: string,
): TaskResult {
  try {
    const run = dbExec(
      'INSERT INTO task_results (task_name, status, output, duration_ms, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
      taskName, status, output, durationMs, startedAt, finishedAt,
    );
    const rows = query<TaskResult>(
      'SELECT * FROM task_results WHERE id = ?',
      Number(run.lastInsertRowid),
    );
    if (rows[0]) return rows[0];
    log.error(`persistResult: inserted row not found for task "${taskName}" (rowid ${String(run.lastInsertRowid)})`);
  } catch (err) {
    log.error(`persistResult: failed to store result for task "${taskName}"`, { error: String(err) });
  }
  return { id: -1, task_name: taskName, status, output, duration_ms: durationMs, started_at: startedAt, finished_at: finishedAt };
}

// ── Execution ────────────────────────────────────────────────

/**
 * Run a command as a subprocess and return captured output.
 */
export function runTask(
  taskName: string,
  options: RunOptions,
): Promise<TaskResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const timeoutMs = options.timeoutMs ?? (loadConfig().task_runner?.default_timeout_ms ?? 300_000); // 5 min default

  return new Promise((resolve) => {
    // Require explicit args array — no shell fallback
    if (!options.args || options.args.length === 0) {
      log.error(`Task "${taskName}" has no args array. Shell fallback (/bin/sh -c) is disabled for security. Add an explicit args array to the task config.`);
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      resolve(persistResult(taskName, 'failure', 'No args array provided — shell fallback disabled', durationMs, startedAt, finishedAt));
      return;
    }
    const cmd = options.command;
    const args = options.args;

    const child = execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: loadConfig().task_runner?.max_buffer_bytes ?? 1024 * 1024, // 1MB
        env: { ...process.env, ...options.env },
        cwd: options.cwd,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startMs;
        const finishedAt = new Date().toISOString();
        const output = (stdout + (stderr ? '\n' + stderr : '')).trim().slice(0, loadConfig().task_runner?.max_output_chars ?? 50_000);

        let status: TaskResult['status'] = 'success';
        if (error) {
          status = error.killed ? 'timeout' : 'failure';
        }

        resolve(persistResult(taskName, status, output || null, durationMs, startedAt, finishedAt));
      },
    );

    // Ensure child doesn't keep the process alive
    child.unref();
  });
}

/**
 * Get task execution history.
 */
export function getTaskHistory(taskName?: string, limit = 50): TaskResult[] {
  if (taskName) {
    return query<TaskResult>(
      'SELECT * FROM task_results WHERE task_name = ? ORDER BY id DESC LIMIT ?',
      taskName,
      limit,
    );
  }
  return query<TaskResult>(
    'SELECT * FROM task_results ORDER BY id DESC LIMIT ?',
    limit,
  );
}
