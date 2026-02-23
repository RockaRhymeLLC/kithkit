/**
 * Todo Reminder — prompts the agent to work on pending todos.
 *
 * Queries the todos table in SQLite for actionable items and injects
 * a reminder into the comms tmux session.
 */

import { query } from '../../core/db.js';
import { injectMessage, listSessions } from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('todo-reminder');

interface TodoRow {
  id: number;
  title: string;
  priority: string;
  status: string;
}

async function run(): Promise<void> {
  // Check if comms session is alive using tmux.ts (works under launchd)
  const sessions = listSessions();
  if (sessions.length === 0) {
    log.debug('Skipping reminder: no tmux session');
    return;
  }

  // Query actionable todos (pending or in_progress)
  const actionable = query<TodoRow>(
    `SELECT id, title, priority, status FROM todos
     WHERE status IN ('pending', 'in_progress')
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       created_at ASC`,
  );

  if (actionable.length === 0) {
    log.debug('No actionable todos');
    return;
  }

  // Pick the highest-priority todo as suggestion
  const top = actionable[0]!;
  const suggestion = ` Highest priority: [#${top.id}] ${top.title}`;

  log.info(`Reminding about ${actionable.length} actionable todo(s)`);

  const reminder = `[System] You have ${actionable.length} actionable todo(s).${suggestion} Run /todo list, pick one, and start working on it now.`;
  const injected = injectMessage('comms', reminder);
  if (!injected) {
    log.warn('Failed to inject todo reminder into comms session');
  }
}

/**
 * Register the todo-reminder task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('todo-reminder', async () => {
    await run();
  });
}
