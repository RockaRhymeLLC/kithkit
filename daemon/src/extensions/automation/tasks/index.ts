/**
 * BMO Scheduler Tasks — registers all BMO-specific task handlers.
 *
 * NOTE: Upstream moved instance-specific tasks to per-agent directories
 * loaded via external task loader. BMO keeps them here since they're
 * actively used and registered in the BMO extension.
 *
 * Remaining tasks here are generic/core — useful for all agents.
 */

import type { Scheduler } from '../../../automation/scheduler.js';

import { register as registerNightlyTodo } from './nightly-todo.js';
import { register as registerBlogReminder } from './blog-reminder.js';
import { register as registerSupabaseKeepAlive } from './supabase-keep-alive.js';
import { register as registerMorningBriefing } from './morning-briefing.js';
import { register as registerA2aDigest } from './a2a-digest.js';
import { register as registerMemorySync } from './memory-sync.js';
import { register as registerLindeeInboxWatch } from './lindee-inbox-watch.js';
import { register as registerPeerHeartbeat } from './peer-heartbeat.js';
import { register as registerMemoryConsolidation } from './memory-consolidation.js';

/**
 * Register all BMO-specific task handlers with the scheduler.
 * Called from the BMO extension's onInit().
 *
 * Only registers handlers for tasks that exist in the scheduler config —
 * this prevents errors in test configs that don't include all tasks.
 */
export function registerBmoTasks(scheduler: Scheduler): void {
  const registrations: Array<[string, (s: Scheduler) => void]> = [
    ['nightly-todo', registerNightlyTodo],
    ['blog-reminder', registerBlogReminder],
    ['supabase-keep-alive', registerSupabaseKeepAlive],
    ['morning-briefing', registerMorningBriefing],
    ['a2a-digest', registerA2aDigest],
    ['memory-sync', registerMemorySync],
    ['lindee-inbox-watch', registerLindeeInboxWatch],
    ['peer-heartbeat', registerPeerHeartbeat],
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
  'nightly-todo',
  'blog-reminder',
  'supabase-keep-alive',
  'morning-briefing',
  'a2a-digest',
  'memory-sync',
  'lindee-inbox-watch',
  'peer-heartbeat',
  'memory-consolidation',
]);
