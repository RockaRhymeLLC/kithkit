/**
 * Stale-todo-archive — auto-archives stale FYI/Reminder/Maintenance todos.
 *
 * Runs daily (configured via cron in kithkit.defaults.yaml).
 * Archives todos with matching title prefixes that haven't been updated
 * in stale_days (default 14). Initial deploy uses dry_run=true — flip to
 * false after reviewing the log for a week.
 *
 * Configurable via scheduler task config:
 *   stale_days: number (default 14)
 *   title_prefixes: string[] (default ["FYI:", "Reminder:", "Maintenance:"])
 *   dry_run: boolean (default false)
 *   log_path: string (default "logs/stale-todo-archive.log")
 */

import { query, exec } from '../../core/db.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Scheduler } from '../scheduler.js';

interface TodoRow {
  id: number;
  title: string;
}

export async function run(config: Record<string, unknown> = {}): Promise<void> {
  const staleDays = (config.stale_days as number) ?? 14;
  const titlePrefixes = (config.title_prefixes as string[]) ?? ['FYI:', 'Reminder:', 'Maintenance:'];
  const dryRun = (config.dry_run as boolean) ?? false;
  const logPath = (config.log_path as string) ?? 'logs/stale-todo-archive.log';

  // Fetch pending/blocked todos older than staleDays, cap at 500
  const rows = query<TodoRow>(
    `SELECT id, title FROM todos
     WHERE status IN ('pending', 'blocked')
       AND updated_at < datetime('now', ?)
     LIMIT 500`,
    `-${staleDays} days`,
  );

  // Filter by title prefix in TS (avoids a dynamic LIKE-chain in SQL)
  const matching = rows.filter(row =>
    titlePrefixes.some(prefix => row.title.startsWith(prefix)),
  );

  if (!dryRun) {
    for (const row of matching) {
      exec(
        `UPDATE todos SET status='done', updated_at=datetime('now') WHERE id = ?`,
        row.id,
      );
    }
  }

  // Write a single log line: timestamp, count, dry_run flag, IDs, first 3 titles for spot-check
  const ts = new Date().toISOString();
  const ids = matching.map(r => r.id).join(', ');
  const spotCheck = matching.slice(0, 3).map(r => r.title).join('; ');
  const logLine = `${ts} | count=${matching.length} | dry_run=${dryRun} | ids=[${ids}] | titles=[${spotCheck}]\n`;

  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, logLine);
}

/**
 * Register the stale-todo-archive task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('stale-todo-archive', async (ctx) => {
    await run(ctx.config);
  });
}
