/**
 * Scheduler engine — cron/interval task runner.
 *
 * Reads task definitions from config, schedules them, and spawns subprocesses.
 * Tasks check idle status before running (configurable).
 * Config changes (add/remove/update) applied via reload() without daemon restart.
 */

import { CronExpressionParser } from 'cron-parser';
import { parseInterval, type TaskScheduleConfig } from '../core/config.js';
import { runTask, type TaskResult } from './task-runner.js';

// ── Types ────────────────────────────────────────────────────

export interface ScheduledTask {
  name: string;
  enabled: boolean;
  schedule: { type: 'cron'; expression: string } | { type: 'interval'; ms: number };
  command: string;
  args: string[];
  config: Record<string, unknown>;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  running: boolean;
}

export interface SchedulerOptions {
  tasks: TaskScheduleConfig[];
  tickIntervalMs?: number;
  onTaskComplete?: (result: TaskResult) => void;
}

// ── Scheduler ────────────────────────────────────────────────

export class Scheduler {
  private _tasks = new Map<string, ScheduledTask>();
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _tickIntervalMs: number;
  private _onTaskComplete?: (result: TaskResult) => void;
  private _started = false;

  constructor(options: SchedulerOptions) {
    this._tickIntervalMs = options.tickIntervalMs ?? 1000;
    this._onTaskComplete = options.onTaskComplete;
    this._loadTasks(options.tasks);
  }

  // ── Public API ──────────────────────────────────────────

  /**
   * Start the scheduler tick loop.
   */
  start(): void {
    if (this._started) return;
    this._started = true;

    // Calculate initial next-run times
    for (const task of this._tasks.values()) {
      if (task.enabled) {
        task.nextRunAt = this._calculateNextRun(task);
      }
    }

    this._tickTimer = setInterval(() => this._tick(), this._tickIntervalMs);
    // Don't keep process alive just for the scheduler
    if (this._tickTimer.unref) this._tickTimer.unref();
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    this._started = false;
  }

  /**
   * Get list of all registered tasks with their status.
   */
  getTasks(): ScheduledTask[] {
    return [...this._tasks.values()];
  }

  /**
   * Get a single task by name.
   */
  getTask(name: string): ScheduledTask | undefined {
    return this._tasks.get(name);
  }

  /**
   * Manually trigger a task (bypasses schedule and idle check).
   */
  async triggerTask(name: string): Promise<TaskResult> {
    const task = this._tasks.get(name);
    if (!task) throw new Error(`Task not found: ${name}`);

    return this._runTask(task);
  }

  /**
   * Reload tasks from new config. Adds new tasks, removes deleted ones,
   * updates changed ones. Running tasks are not interrupted.
   */
  reload(tasks: TaskScheduleConfig[]): void {
    const newNames = new Set(tasks.map(t => t.name));

    // Remove tasks no longer in config
    for (const name of this._tasks.keys()) {
      if (!newNames.has(name)) {
        this._tasks.delete(name);
      }
    }

    // Add/update tasks
    for (const taskConfig of tasks) {
      const existing = this._tasks.get(taskConfig.name);
      if (existing && existing.running) {
        // Don't interrupt running tasks — just update config for next run
        this._updateTask(existing, taskConfig);
      } else {
        const scheduled = this._parseTask(taskConfig);
        if (scheduled.enabled && this._started) {
          scheduled.nextRunAt = this._calculateNextRun(scheduled);
        }
        this._tasks.set(taskConfig.name, scheduled);
      }
    }
  }

  /**
   * Check if scheduler is running.
   */
  isRunning(): boolean {
    return this._started;
  }

  // ── Internals ──────────────────────────────────────────

  private _loadTasks(configs: TaskScheduleConfig[]): void {
    for (const config of configs) {
      const task = this._parseTask(config);
      this._tasks.set(task.name, task);
    }
  }

  private _parseTask(config: TaskScheduleConfig): ScheduledTask {
    let schedule: ScheduledTask['schedule'];
    if (config.cron) {
      schedule = { type: 'cron', expression: config.cron };
    } else if (config.interval) {
      schedule = { type: 'interval', ms: parseInterval(config.interval) };
    } else {
      throw new Error(`Task "${config.name}" must have either cron or interval`);
    }

    // Command comes from config (config.command or config.config.command)
    const taskConfig = (config.config ?? {}) as Record<string, unknown>;
    const command = (taskConfig.command as string) ?? `echo "No command for ${config.name}"`;
    const args = (taskConfig.args as string[]) ?? [];

    return {
      name: config.name,
      enabled: config.enabled,
      schedule,
      command,
      args,
      config: taskConfig,
      nextRunAt: null,
      lastRunAt: null,
      running: false,
    };
  }

  private _updateTask(existing: ScheduledTask, config: TaskScheduleConfig): void {
    existing.enabled = config.enabled;
    const taskConfig = (config.config ?? {}) as Record<string, unknown>;
    if (taskConfig.command) existing.command = taskConfig.command as string;
    if (taskConfig.args) existing.args = taskConfig.args as string[];
    existing.config = taskConfig;
  }

  private _calculateNextRun(task: ScheduledTask): Date | null {
    if (!task.enabled) return null;

    if (task.schedule.type === 'cron') {
      try {
        const interval = CronExpressionParser.parse(task.schedule.expression);
        return interval.next().toDate();
      } catch {
        return null;
      }
    }

    if (task.schedule.type === 'interval') {
      const base = task.lastRunAt ? new Date(task.lastRunAt) : new Date();
      return new Date(base.getTime() + task.schedule.ms);
    }

    return null;
  }

  private _tick(): void {
    const now = new Date();

    for (const task of this._tasks.values()) {
      if (!task.enabled || task.running || !task.nextRunAt) continue;

      if (now >= task.nextRunAt) {
        // Fire and forget — don't await in the tick loop
        this._runTask(task).catch(() => {
          // Error already captured in task result
        });
      }
    }
  }

  private async _runTask(task: ScheduledTask): Promise<TaskResult> {
    task.running = true;

    try {
      const result = await runTask(task.name, {
        command: task.command,
        args: task.args,
        timeoutMs: (task.config.timeout_ms as number) ?? 300_000,
        cwd: task.config.cwd as string | undefined,
      });

      task.lastRunAt = new Date().toISOString() as unknown as Date;
      task.nextRunAt = this._calculateNextRun(task);

      if (this._onTaskComplete) {
        this._onTaskComplete(result);
      }

      return result;
    } finally {
      task.running = false;
    }
  }
}
