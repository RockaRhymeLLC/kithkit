/**
 * Core scheduler tasks — registers all built-in task handlers.
 *
 * Call registerCoreTasks(scheduler) after creating the Scheduler instance.
 * Each task must also have a corresponding entry in kithkit.config.yaml
 * (or kithkit.defaults.yaml) for the scheduler to schedule it.
 *
 * External tasks can be loaded from configurable directories via
 * loadExternalTasks() — see scheduler.tasks_dirs in config.
 */

import type { Scheduler } from '../scheduler.js';
import { register as registerContextWatchdog } from './context-watchdog.js';
import { register as registerTodoReminder } from './todo-reminder.js';
import { register as registerApprovalAudit } from './approval-audit.js';
import { register as registerBackup } from './backup.js';
import { register as registerOrchestratorIdle } from './orchestrator-idle.js';
import { register as registerMessageDelivery } from './message-delivery.js';
import { register as registerCommsHeartbeat } from './comms-heartbeat.js';
import { register as registerPeerHeartbeat } from './peer-heartbeat.js';
import { register as registerMetricsAggregation } from './api-metrics-aggregation.js';
import { register as registerDailyDigest } from './daily-digest.js';
import { register as registerMorningBriefing } from './morning-briefing.js';
import { register as registerKkitReflection } from './kkit-reflection.js';
export { loadExternalTasks, type LoadResult } from './external-loader.js';

/**
 * Register all core task handlers with the scheduler.
 * Only registers handlers for tasks that exist in config.
 * Silently skips tasks that aren't configured.
 */
export function registerCoreTasks(scheduler: Scheduler): void {
  const registrations = [
    { name: 'context-watchdog', register: registerContextWatchdog },
    { name: 'todo-reminder', register: registerTodoReminder },
    { name: 'approval-audit', register: registerApprovalAudit },
    { name: 'backup', register: registerBackup },
    { name: 'orchestrator-idle', register: registerOrchestratorIdle },
    { name: 'message-delivery', register: registerMessageDelivery },
    { name: 'comms-heartbeat', register: registerCommsHeartbeat },
    { name: 'peer-heartbeat', register: registerPeerHeartbeat },
    { name: 'api-metrics-aggregation', register: registerMetricsAggregation },
    { name: 'daily-digest', register: registerDailyDigest },
    { name: 'morning-briefing', register: registerMorningBriefing },
    { name: 'kkit-reflection', register: registerKkitReflection },
  ];

  for (const { name, register } of registrations) {
    const task = scheduler.getTask(name);
    if (task) {
      register(scheduler);
    }
  }
}
