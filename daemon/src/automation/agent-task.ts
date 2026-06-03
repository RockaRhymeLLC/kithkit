/**
 * AgentTask — public interface for hot-loaded scheduled job files.
 *
 * Job files placed in `.kithkit/scheduled-jobs/` can use either of two shapes:
 *
 *   Shape A — register function (built-in pattern, all existing tasks):
 *     export function register(scheduler) {
 *       scheduler.registerHandler('my-task', async (ctx) => { ... });
 *     }
 *
 *   Shape B — default export using defineTask() (simpler, recommended for new jobs):
 *     import { defineTask } from 'path/to/agent-task.js';
 *     export default defineTask({
 *       name: 'my-task',
 *       schedule: { type: 'cron', expression: '0 * * * *' },
 *       async run(ctx) {
 *         // ctx.taskName, ctx.config available
 *       },
 *     });
 *
 * defineTask() is a pass-through helper that provides TypeScript type-checking
 * without requiring the file to import the Scheduler class directly.
 */

import type { TaskHandlerContext } from './scheduler.js';

export type { TaskHandlerContext };

export interface AgentTask {
  /** Unique task name. Must be unique across all loaded tasks. */
  name: string;
  /** Schedule — cron expression or fixed interval in milliseconds. */
  schedule: { type: 'cron'; expression: string } | { type: 'interval'; ms: number };
  /** Task body — called each time the schedule fires. */
  run(ctx: TaskHandlerContext): Promise<void>;
  /** Optional: validate config before loading (reserved for future use). */
  validate?(config: unknown): boolean;
}

/**
 * Identity helper — returns the AgentTask object unchanged.
 * Provides TypeScript type inference for the `export default defineTask({...})` pattern.
 */
export function defineTask(task: AgentTask): AgentTask {
  return task;
}
