/**
 * Todo Reminder — prompts the agent to work on pending todos.
 *
 * Queries the database for actionable todos and injects a reminder
 * into the session. Skips if all todos are blocked.
 *
 * Configurable via scheduler task config:
 *   idle_nudge: string — text injected when no open todos exist.
 *     Defaults to a generic "look for useful work" message.
 */

import { query } from '../../core/db.js';
import { injectText, sessionExists } from '../../core/session-bridge.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('todo-reminder');

const DEFAULT_IDLE_NUDGE =
  '[System] No open todos. Look for useful work: check for unread messages, review PRs, explore improvements, or check in with the team.';

interface TodoRow {
  id: string;
  title: string;
  status: string;
  priority: string | null;
}

async function run(config: Record<string, unknown> = {}): Promise<void> {
  // Check if comms session is alive
  if (!sessionExists()) {
    log.debug('Skipping reminder: no tmux session');
    return;
  }

  // Query actionable todos from the database
  const todos = query<TodoRow>(
    `SELECT id, title, status, priority FROM todos
     WHERE status IN ('pending', 'in_progress', 'blocked')
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
       created_at ASC`,
  );

  if (todos.length === 0) {
    log.info('No open todos — nudging agent to find useful work');
    const nudge = (config.idle_nudge as string) ?? DEFAULT_IDLE_NUDGE;
    injectText(nudge);
    return;
  }

  // Categorize todos: actionable vs blocked
  const actionable = todos.filter(t => t.status !== 'blocked');
  const blockedCount = todos.length - actionable.length;

  // If ALL todos are blocked, skip the nag
  if (actionable.length === 0 && blockedCount > 0) {
    log.debug(`All ${blockedCount} todo(s) are blocked — skipping reminder`);
    return;
  }

  // Suggest the highest priority actionable todo
  let suggestion = '';
  if (actionable[0]) {
    suggestion = ` Highest priority: [${actionable[0].id}] ${actionable[0].title}`;
  }

  const blockedNote = blockedCount > 0 ? ` (${blockedCount} blocked)` : '';
  log.info(`Reminding about ${actionable.length} actionable todo(s)${blockedNote}`);

  const reminder = `[System] You have ${actionable.length} actionable todo(s)${blockedNote}.${suggestion} Run /todo list, pick one, and start working on it now.`;
  injectText(reminder);
}

/**
 * Register the todo-reminder task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('todo-reminder', async (ctx) => {
    await run(ctx.config);
  });
}
