/**
 * Todo Reminder — prompts the agent to work on pending todos.
 *
 * Fetches all non-done todos and classifies them into:
 *   - actionable: pending, or in_progress with no active snooze
 *   - snoozed: in_progress with snooze_until in the future
 *   - blocked: blocked status
 *
 * Always injects a message — no early return — so the 30-minute
 * always-inject guarantee is preserved regardless of todo state.
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

const SLEEP_HINT =
  '\n\n_To snooze reminders, POST /api/scheduler/tasks/todo-reminder/sleep with {"hours": N, "reason": "written justification"}. Max 4h. Reason is required and logged._';

const DEFAULT_IDLE_NUDGE =
  `If not actively working — do the following NOW:

1. Run /todo list and review every open todo. For each unblocked one: escalate it to the orchestrator or do it directly.
2. Check your GitHub repos for unassigned issues, failed CI, or stale PRs you can act on.
3. Check daemon logs and system health for errors worth fixing or filing.
4. Check recent git activity for anything needing follow-up.

If after doing ALL of that you have ZERO work you can do, list what you checked and why every item is blocked. Then you may snooze — max 4 hours, with a written justification.

Do not rationalize. Do not snooze first. Do the work.`;

export interface TodoRow {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  snooze_until: string | null;
}

export interface ClassifyResult {
  actionable: TodoRow[];
  snoozed: TodoRow[];
  blocked: TodoRow[];
}

/**
 * Classify a list of todos into actionable, snoozed, and blocked buckets.
 * Exported for unit testing.
 */
export function classifyTodos(todos: TodoRow[], now: Date): ClassifyResult {
  const actionable: TodoRow[] = [];
  const snoozed: TodoRow[] = [];
  const blocked: TodoRow[] = [];

  for (const t of todos) {
    if (t.status === 'blocked') {
      blocked.push(t);
    } else if (t.status === 'in_progress' && t.snooze_until && new Date(t.snooze_until) > now) {
      snoozed.push(t);
    } else {
      // pending, or in_progress with expired/no snooze
      actionable.push(t);
    }
  }

  return { actionable, snoozed, blocked };
}

async function run(config: Record<string, unknown> = {}): Promise<void> {
  // Check if comms session is alive
  if (!sessionExists()) {
    log.debug('Skipping reminder: no tmux session');
    return;
  }

  // Query all non-done todos from the database
  const todos = query<TodoRow>(
    `SELECT id, title, status, priority, snooze_until FROM tasks WHERE kind = 'todo'
     AND status NOT IN ('done', 'completed', 'cancelled')
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
       created_at ASC
     LIMIT 10`,
  );

  const now = new Date();
  const { actionable, snoozed, blocked } = classifyTodos(todos, now);

  if (actionable.length > 0) {
    // Variant 3: actionable items exist — list count + highest priority
    const top = actionable[0]!;
    const snoozedNote = snoozed.length > 0 ? ` (${snoozed.length} snoozed)` : '';
    const blockedNote = blocked.length > 0 ? ` (${blocked.length} blocked)` : '';
    const suggestion = ` Highest priority: [${top.id}] ${top.title}`;

    log.info(`Reminding about ${actionable.length} actionable todo(s)${snoozedNote}${blockedNote}`);

    const message =
      `[System] You have ${actionable.length} actionable todo(s)${snoozedNote}${blockedNote}.${suggestion} Run /todo list, pick one, and start working on it now.${SLEEP_HINT}`;
    injectText(message);
  } else if (snoozed.length > 0) {
    // Variant 2: todos exist but all snoozed (none actionable, none blocked-only)
    log.info(`${snoozed.length} todo(s) in-flight but all snoozed — prompting review`);

    const message =
      `[System] ${snoozed.length} todo(s) in-flight but all snoozed. Worth reviewing for unblocking — check /todo list to see if any snoozes have expired or work can be advanced.${SLEEP_HINT}`;
    injectText(message);
  } else if (todos.length === 0) {
    // Variant 1: no open todos at all
    log.info('No open todos — nudging agent to find useful work');
    const nudge = (config.idle_nudge as string) ?? DEFAULT_IDLE_NUDGE;
    injectText(`${nudge}${SLEEP_HINT}`);
  } else {
    // All remaining todos are blocked
    log.info(`All ${todos.length} todo(s) are blocked — nudging agent to find useful work`);
    const nudge = (config.idle_nudge as string) ?? DEFAULT_IDLE_NUDGE;
    injectText(`${nudge}${SLEEP_HINT}`);
  }
}

/**
 * Register the todo-reminder task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('todo-reminder', async (ctx) => {
    await run(ctx.config);
  });
}
