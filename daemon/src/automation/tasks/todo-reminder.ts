/**
 * Todo Reminder — prompts the agent to work on pending todos.
 *
 * Checks the todos directory for actionable items and injects a reminder
 * into the session. Skips if all todos are blocked.
 */

import fs from 'node:fs';
import { resolveProjectPath } from '../../core/config.js';
import { injectText, sessionExists } from '../../core/session-bridge.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('todo-reminder');

async function run(): Promise<void> {
  if (!sessionExists()) {
    log.debug('Skipping reminder: no tmux session');
    return;
  }

  const todosDir = resolveProjectPath('.claude', 'state', 'todos');

  if (!fs.existsSync(todosDir)) return;

  // Count open, in-progress, and blocked todos
  const files = fs.readdirSync(todosDir);
  const openTodos = files.filter(f =>
    (f.includes('-open-') || f.includes('-in-progress-') || f.includes('-blocked-')) && f.endsWith('.json'),
  );

  if (openTodos.length === 0) {
    log.debug('No open todos');
    return;
  }

  // Categorize todos: actionable vs blocked
  let blockedCount = 0;
  const actionable: { id: string; title: string; file: string }[] = [];
  for (const file of openTodos) {
    try {
      const todo = JSON.parse(fs.readFileSync(`${todosDir}/${file}`, 'utf8'));
      if (todo.status === 'blocked' || file.includes('-blocked-')) {
        blockedCount++;
      } else {
        actionable.push({ id: todo.id, title: todo.title, file });
      }
    } catch {
      // Ignore parse errors
    }
  }

  // If ALL todos are blocked, skip the nag
  if (actionable.length === 0 && blockedCount > 0) {
    log.debug(`All ${blockedCount} todo(s) are blocked — skipping reminder`);
    return;
  }

  // Find the highest priority actionable todo to suggest
  let suggestion = '';
  const sorted = actionable.sort((a, b) => a.file.localeCompare(b.file));
  if (sorted[0]) {
    suggestion = ` Highest priority: [${sorted[0].id}] ${sorted[0].title}`;
  }

  const blockedNote = blockedCount > 0 ? ` (${blockedCount} blocked)` : '';
  log.info(`Reminding about ${actionable.length} actionable todo(s)${blockedNote}`);

  const reminder = `[System] You have ${actionable.length} actionable todo(s)${blockedNote}.${suggestion} Run /todo list, pick one, and start working on it now.`;
  injectText(reminder);
}

/**
 * Register the todo-reminder task with the scheduler.
 * Handles its own session check (set requires_session: false in config).
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('todo-reminder', async () => {
    await run();
  });
}
