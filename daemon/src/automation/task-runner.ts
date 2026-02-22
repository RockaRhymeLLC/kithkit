/**
 * Task runner — executes tasks as subprocesses and captures results.
 *
 * Tasks can be any executable: bash scripts, Python, TypeScript, `claude -p`, etc.
 * Output is captured (stdout + stderr merged) and stored with duration.
 */

import { execFile } from 'node:child_process';
import { exec as dbExec, query } from '../core/db.js';

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
  const timeoutMs = options.timeoutMs ?? 300_000; // 5 min default

  return new Promise((resolve) => {
    const child = execFile(
      options.command,
      options.args ?? [],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, ...options.env },
        cwd: options.cwd,
        shell: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startMs;
        const finishedAt = new Date().toISOString();
        const output = (stdout + (stderr ? '\n' + stderr : '')).trim().slice(0, 50_000);

        let status: TaskResult['status'] = 'success';
        if (error) {
          status = error.killed ? 'timeout' : 'failure';
        }

        // Store in DB
        dbExec(
          'INSERT INTO task_results (task_name, status, output, duration_ms, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
          taskName,
          status,
          output || null,
          durationMs,
          startedAt,
          finishedAt,
        );

        // Get the inserted row
        const rows = query<TaskResult>(
          'SELECT * FROM task_results WHERE task_name = ? ORDER BY id DESC LIMIT 1',
          taskName,
        );

        resolve(rows[0]!);
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
