/**
 * Stale-todo-surfacing — weekly report of stale pending/in-progress todos.
 *
 * Runs weekly on Monday mornings (configured via cron in kithkit.defaults.yaml).
 * Sends a summary of stale todos to the human via the daemon's /api/send endpoint.
 * Exits silently if there are no stale todos to report.
 *
 * Works whether the comms agent is awake or asleep — delivery is handled by
 * the daemon's channel router (/api/send).
 *
 * Configurable via scheduler task config:
 *   pending_days: number (default 14)
 *   in_progress_days: number (default 7)
 *   max_items: number (default 20)
 *   channel: string|null (default null — let router decide)
 */

import { query } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import type { Scheduler } from '../scheduler.js';

interface TodoRow {
  id: number;
  title: string;
  updated_at: string | null;
}

export async function run(config: Record<string, unknown> = {}): Promise<void> {
  const pendingDays = (config.pending_days as number) ?? 14;
  const inProgressDays = (config.in_progress_days as number) ?? 7;
  const maxItems = (config.max_items as number) ?? 20;
  const channel = (config.channel as string | null) ?? null;

  // Two queries, each sorted oldest-first
  const pendingRows = query<TodoRow>(
    `SELECT id, title, updated_at FROM todos
     WHERE status = 'pending'
       AND updated_at < datetime('now', ?)
     ORDER BY updated_at ASC`,
    `-${pendingDays} days`,
  );

  const inProgressRows = query<TodoRow>(
    `SELECT id, title, updated_at FROM todos
     WHERE status = 'in_progress'
       AND updated_at < datetime('now', ?)
     ORDER BY updated_at ASC`,
    `-${inProgressDays} days`,
  );

  // Concatenate and cap to maxItems
  const combined = [...pendingRows, ...inProgressRows];
  if (combined.length === 0) {
    return; // Nothing to surface — exit silently
  }

  // Split the cap back into buckets (pending comes first in combined)
  const pendingCount = Math.min(pendingRows.length, maxItems);
  const pendingInMsg = pendingRows.slice(0, pendingCount);
  const inProgressInMsg = inProgressRows.slice(0, maxItems - pendingCount);

  // Compose message
  const lines: string[] = ['Weekly stale-todo surfacing (auto):'];

  lines.push(`Pending > ${pendingDays}d (${pendingInMsg.length}):`);
  for (const row of pendingInMsg) {
    const dateStr = row.updated_at
      ? (row.updated_at.split('T')[0] ?? row.updated_at.split(' ')[0] ?? row.updated_at)
      : 'unknown';
    lines.push(`\u2022 #${row.id} \u2014 ${row.title} (last touch: ${dateStr})`);
  }

  lines.push(`In-progress > ${inProgressDays}d (${inProgressInMsg.length}):`);
  for (const row of inProgressInMsg) {
    const dateStr = row.updated_at
      ? (row.updated_at.split('T')[0] ?? row.updated_at.split(' ')[0] ?? row.updated_at)
      : 'unknown';
    lines.push(`\u2022 #${row.id} \u2014 ${row.title} (last touch: ${dateStr})`);
  }

  lines.push('Reply /todo close <id> or /todo update <id>.');

  const message = lines.join('\n');

  // Deliver via daemon send API
  const cfg = loadConfig();
  // TODO: read from config
  const port = (cfg as unknown as Record<string, Record<string, unknown>>)?.daemon?.port ?? 3847;

  const payload: Record<string, unknown> = { message };
  if (channel) {
    payload.channel = channel;
  }

  await globalThis.fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Register the stale-todo-surfacing task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('stale-todo-surfacing', async (ctx) => {
    await run(ctx.config);
  });
}
