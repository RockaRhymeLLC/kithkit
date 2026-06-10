/**
 * notify-todo-expire — auto-expires one-time NOTIFY and auto-created todos.
 *
 * Targets todos tagged with source LIKE 'auto:%' (e.g. 'auto:notify',
 * 'auto:reflection', 'auto:granola').  Never touches todos with NULL or
 * non-auto source values (real work todos created by humans/orchestrator).
 *
 * Expiry order of preference:
 *   1. BY-DATE-PASSED — due_date is set and is in the past.
 *   2. TTL FALLBACK   — created more than ttl_days ago and untouched
 *                       (no task_actions beyond the initial 'created' entry).
 *
 * Protected classes (never auto-expired):
 *   - priority = 'urgent'
 *   - title or description contains financial/urgent keywords
 *     (low-balance, low balance, credits-exhausted, payment, billing,
 *      invoice, financial, overdue, bank, charge)
 *
 * Auto-close = status → 'cancelled' with a task_action entry
 * (action='auto-expired', note=reason string). Keeps audit trail.
 * Does NOT hard-delete rows.
 *
 * Configurable via scheduler task config:
 *   enabled:    boolean (default true)
 *   ttl_days:   number  (default 14)
 *   dry_run:    boolean (default false)
 *   log_path:   string  (default 'logs/notify-todo-expire.log')
 */

import { query, exec } from '../../core/db.js';
import { createLogger } from '../../core/logger.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('notify-todo-expire');

// ── Constants ─────────────────────────────────────────────────

export const PROTECTED_FINANCIAL_KEYWORDS: string[] = [
  'low-balance',
  'low balance',
  'credits-exhausted',
  'credits exhausted',
  'payment',
  'billing',
  'invoice',
  'financial',
  'overdue',
  'bank',
  'charge',
];

// Terminal statuses — tasks in these states are already closed.
const TERMINAL_STATUSES = ['completed', 'failed', 'abandoned', 'cancelled'];

// ── Types ─────────────────────────────────────────────────────

interface AutoTodo {
  id: number;
  title: string;
  description: string | null;
  source: string | null;
  priority: string;
  status: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionCount {
  count: number;
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Returns true if the title or description contains any protected financial
 * keyword (case-insensitive).
 */
function hasFinancialKeyword(title: string, description: string | null): boolean {
  const haystack = `${title} ${description ?? ''}`.toLowerCase();
  return PROTECTED_FINANCIAL_KEYWORDS.some(kw => haystack.includes(kw.toLowerCase()));
}

/**
 * Returns true if the todo has no task_actions other than the initial
 * 'created' entry — i.e., it has never been touched/updated.
 */
function isUntouched(todoId: number): boolean {
  const rows = query<ActionCount>(
    `SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action != 'created'`,
    todoId,
  );
  return (rows[0]?.count ?? 0) === 0;
}

// ── Core run logic ─────────────────────────────────────────────

export async function _runForTesting(config: Record<string, unknown>): Promise<void> {
  return run(config);
}

async function run(config: Record<string, unknown> = {}): Promise<void> {
  const enabled = config.enabled !== false; // default true
  if (!enabled) {
    log.debug('notify-todo-expire is disabled — skipping');
    return;
  }

  const ttlDays = typeof config.ttl_days === 'number' ? config.ttl_days : 14;
  const dryRun = config.dry_run === true;
  const logPath = typeof config.log_path === 'string' ? config.log_path : 'logs/notify-todo-expire.log';

  const now = new Date();
  const ttlCutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);

  // Query all open (non-terminal) todos where source LIKE 'auto:%'
  const candidates = query<AutoTodo>(
    `SELECT id, title, description, source, priority, status, due_date, created_at, updated_at
     FROM tasks
     WHERE kind = 'todo'
       AND source LIKE 'auto:%'
       AND status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})
     LIMIT 500`,
    ...TERMINAL_STATUSES,
  );

  let expiredCount = 0;
  let skippedProtected = 0;
  let skippedFresh = 0;
  const expiredIds: number[] = [];

  for (const todo of candidates) {
    // Guard: urgent priority
    if (todo.priority === 'urgent') {
      skippedProtected++;
      continue;
    }

    // Guard: financial/urgent keywords in title or description
    if (hasFinancialKeyword(todo.title, todo.description)) {
      skippedProtected++;
      continue;
    }

    let shouldExpire = false;
    let reason = '';

    // Check 1: by-date-passed
    if (todo.due_date) {
      const dueDate = new Date(todo.due_date);
      if (!isNaN(dueDate.getTime()) && dueDate < now) {
        shouldExpire = true;
        reason = `due_date ${todo.due_date} is in the past`;
      }
    }

    // Check 2: TTL fallback (only if not already flagged by date)
    if (!shouldExpire) {
      const createdAt = new Date(todo.created_at);
      if (!isNaN(createdAt.getTime()) && createdAt < ttlCutoff) {
        // Only expire if untouched (no task_actions beyond 'created')
        if (isUntouched(todo.id)) {
          shouldExpire = true;
          reason = `created ${todo.created_at} is older than TTL (${ttlDays} days) and untouched`;
        } else {
          skippedFresh++;
        }
      } else {
        skippedFresh++;
      }
    }

    if (!shouldExpire) continue;

    if (!dryRun) {
      const oldStatus = todo.status;

      exec(
        `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
        todo.id,
      );

      exec(
        `INSERT INTO task_actions (task_id, action, old_value, new_value, note) VALUES (?, 'auto-expired', ?, 'cancelled', ?)`,
        todo.id,
        oldStatus,
        reason,
      );

      log.info('Auto-expired todo', {
        id: todo.id,
        title: todo.title.slice(0, 80),
        source: todo.source,
        reason,
      });
    } else {
      log.info('[DRY RUN] Would auto-expire todo', {
        id: todo.id,
        title: todo.title.slice(0, 80),
        source: todo.source,
        reason,
      });
    }

    expiredCount++;
    expiredIds.push(todo.id);
  }

  // Write summary log line
  const ts = now.toISOString();
  const logLine =
    `${ts} | expired=${expiredCount} | skipped_protected=${skippedProtected} | skipped_fresh=${skippedFresh} | dry_run=${dryRun} | ids=[${expiredIds.join(', ')}]\n`;

  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, logLine);

  log.info('notify-todo-expire sweep complete', {
    expired: expiredCount,
    skippedProtected,
    skippedFresh,
    dryRun,
    total: candidates.length,
  });
}

// ── Registration ──────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('notify-todo-expire', async (ctx) => {
    await run(ctx.config);
  });
}
