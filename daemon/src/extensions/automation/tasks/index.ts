/**
 * Extension Scheduler Tasks — registers core extension task handlers.
 *
 * Instance-specific tasks (morning-briefing, blog-reminder, nightly-todo,
 * a2a-digest, email-check, memory-sync, supabase-keep-alive) have been moved
 * to per-agent directories and are loaded via the external task loader
 * (scheduler.tasks_dirs config).
 *
 * Remaining tasks here are generic/core — useful for all agents.
 */

import type { Scheduler } from '../../../automation/scheduler.js';

import { register as registerMemoryConsolidation } from './memory-consolidation.js';

/**
 * Register core extension task handlers with the scheduler.
 * Called from the extension's onInit().
 *
 * Only registers handlers for tasks that exist in the scheduler config —
 * this prevents errors in test configs that don't include all tasks.
 */
export function registerR2Tasks(scheduler: Scheduler): void {
  const registrations: Array<[string, (s: Scheduler) => void]> = [
    ['memory-consolidation', registerMemoryConsolidation],
  ];

  for (const [name, register] of registrations) {
    if (scheduler.getTask(name)) {
      register(scheduler);
    }
  }
}

/** Task names that have real implementations (used to skip stubs). */
export const REAL_TASK_NAMES = new Set([
  'memory-consolidation',
]);
