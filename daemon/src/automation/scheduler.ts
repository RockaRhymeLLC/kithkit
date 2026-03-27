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
import { registerCoreTasks, loadExternalTasks, type LoadResult } from './tasks/index.js';
import { createLogger } from '../core/logger.js';
import { exec as dbExec, query } from '../core/db.js';

// ── Types ────────────────────────────────────────────────────

export interface ScheduledTask {
  name: string;
  enabled: boolean;
  schedule: { type: 'cron'; expression: string } | { type: 'interval'; ms: number };
  command: string;
  args: string[];
  config: Record<string, unknown>;
  idleOnly: boolean;
  idleAfterMs: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  running: boolean;
}

/** Handler function for in-process tasks (registered via registerHandler). */
export type TaskHandler = (context: TaskHandlerContext) => Promise<string | void>;

/** Context passed to in-process task handlers. */
export interface TaskHandlerContext {
  taskName: string;
  config: Record<string, unknown>;
}

export interface SchedulerOptions {
  tasks: TaskScheduleConfig[];
  tickIntervalMs?: number;
  onTaskComplete?: (result: TaskResult) => void;
  /** Returns the timestamp of the last human message (for idle detection). */
  getLastHumanActivity?: () => Date | null;
  /** Check if a named tmux session exists (for requiresSession tasks). */
  sessionExists?: () => boolean;
  /** Auto-register built-in core task handlers (context-watchdog, todo-reminder, etc.). Defaults to true. */
  autoRegisterCoreTasks?: boolean;
}

// ── Scheduler ────────────────────────────────────────────────

export class Scheduler {
  private _tasks = new Map<string, ScheduledTask>();
  private _handlers = new Map<string, TaskHandler>();
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _tickIntervalMs: number;
  private _onTaskComplete?: (result: TaskResult) => void;
  private _getLastHumanActivity?: () => Date | null;
  private _sessionExists?: () => boolean;
  private _started = false;
  private _sleepUntil = new Map<string, Date>();

  constructor(options: SchedulerOptions) {
    this._tickIntervalMs = options.tickIntervalMs ?? 1000;
    this._onTaskComplete = options.onTaskComplete;
    this._getLastHumanActivity = options.getLastHumanActivity;
    this._sessionExists = options.sessionExists;
    this._loadTasks(options.tasks);

    // Auto-register built-in core task handlers unless explicitly disabled
    if (options.autoRegisterCoreTasks !== false) {
      registerCoreTasks(this);
    }
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
   * Register an in-process handler for a task.
   * When the task fires, the handler runs directly instead of spawning a subprocess.
   *
   * @param taskName Must match a task name in config.
   * @param handler Async function to execute.
   * @throws If task name not found in config or if requiresSession but no sessionExists callback.
   */
  registerHandler(taskName: string, handler: TaskHandler): void {
    const task = this._tasks.get(taskName);
    if (!task) {
      throw new Error(`Cannot register handler for unknown task: "${taskName}". Task must exist in config.`);
    }
    const requiresSession = (task.config.requires_session as boolean) ?? false;
    if (requiresSession && !this._sessionExists) {
      throw new Error(
        `Task "${taskName}" has requires_session=true but no sessionExists callback was provided to Scheduler.`,
      );
    }
    this._handlers.set(taskName, handler);
  }

  /**
   * Check if a task has a registered in-process handler.
   */
  hasHandler(taskName: string): boolean {
    return this._handlers.has(taskName);
  }

  /**
   * Load external task handlers from the specified directories.
   *
   * Scans each directory for .js files that export a `register(scheduler)` function.
   * Invalid files and missing directories are logged and skipped gracefully.
   *
   * @param dirs Array of directory paths to scan for task files.
   * @returns Array of load results, one per directory.
   */
  async loadExternalTasks(dirs: string[]): Promise<LoadResult[]> {
    return loadExternalTasks(dirs, this);
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

  /**
   * Put a task to sleep for N hours (in-memory, resets on restart).
   * Returns the wake-up time.
   */
  sleepTask(name: string, hours: number): Date {
    const task = this._tasks.get(name);
    if (!task) throw new Error(`Task not found: ${name}`);
    const wakeAt = new Date(Date.now() + hours * 3_600_000);
    this._sleepUntil.set(name, wakeAt);
    return wakeAt;
  }

  /**
   * Cancel a task's sleep (wake it up immediately).
   */
  wakeTask(name: string): void {
    const task = this._tasks.get(name);
    if (!task) throw new Error(`Task not found: ${name}`);
    this._sleepUntil.delete(name);
  }

  /**
   * Get the sleep state for a task, or null if not sleeping.
   */
  getTaskSleep(name: string): { sleeping_until: string } | null {
    const wakeAt = this._sleepUntil.get(name);
    if (!wakeAt) return null;
    // Auto-expire stale entries
    if (Date.now() >= wakeAt.getTime()) {
      this._sleepUntil.delete(name);
      return null;
    }
    return { sleeping_until: wakeAt.toISOString() };
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
      idleOnly: (taskConfig.idle_only as boolean) ?? false,
      idleAfterMs: (taskConfig.idle_after_ms as number) ?? 300_000, // 5 min default
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

  /**
   * Check if the agent is idle (no human activity within the configured window).
   */
  private _isIdle(idleAfterMs: number): boolean {
    if (!this._getLastHumanActivity) return true; // No tracker = assume idle
    const lastActivity = this._getLastHumanActivity();
    if (!lastActivity) return true; // No activity recorded = assume idle
    return Date.now() - lastActivity.getTime() >= idleAfterMs;
  }

  private _tick(): void {
    const now = new Date();

    for (const task of this._tasks.values()) {
      if (!task.enabled || task.running || !task.nextRunAt) continue;

      if (now >= task.nextRunAt) {
        // Skip tasks that are sleeping
        const wakeAt = this._sleepUntil.get(task.name);
        if (wakeAt) {
          if (Date.now() < wakeAt.getTime()) continue;
          // Sleep expired — clean up
          this._sleepUntil.delete(task.name);
        }

        // Skip idle-only tasks when agent is not idle
        if (task.idleOnly && !this._isIdle(task.idleAfterMs)) continue;

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
      // Check requires_session flag
      const requiresSession = (task.config.requires_session as boolean) ?? false;
      if (requiresSession && this._sessionExists && !this._sessionExists()) {
        return {
          id: 0,
          task_name: task.name,
          status: 'success',
          output: 'Skipped: session not available',
          duration_ms: 0,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        };
      }

      // Use in-process handler if registered, otherwise spawn subprocess
      const handler = this._handlers.get(task.name);
      let result: TaskResult;
      if (handler) {
        result = await this._runInProcess(task, handler);
      } else if (task.command) {
        result = await runTask(task.name, {
          command: task.command,
          args: task.args,
          timeoutMs: (task.config.timeout_ms as number) ?? 300_000,
          cwd: task.config.cwd as string | undefined,
        });
      } else {
        // No handler registered and no command configured — skip gracefully.
        // This happens when an extension task is in the scheduler config but
        // the extension hasn't loaded yet (e.g. peer-heartbeat before agent-comms loads).
        const log = createLogger('scheduler');
        log.debug(`Task "${task.name}" has no handler or command — skipping`);
        result = {
          id: 0,
          task_name: task.name,
          status: 'success',
          output: 'Skipped: no handler registered and no command configured',
          duration_ms: 0,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        };
      }

      task.lastRunAt = new Date();
      task.nextRunAt = this._calculateNextRun(task);

      if (this._onTaskComplete) {
        this._onTaskComplete(result);
      }

      return result;
    } finally {
      task.running = false;
    }
  }

  /**
   * Execute a task handler in-process (no subprocess).
   */
  private async _runInProcess(task: ScheduledTask, handler: TaskHandler): Promise<TaskResult> {
    const startedAt = new Date().toISOString();
    const start = Date.now();

    const timeoutMs = (task.config.timeout_ms as number) ?? 300_000; // 5 min default
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`In-process handler timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      // Don't keep process alive just for the timeout
      if (timer.unref) timer.unref();
    });

    try {
      const result = await Promise.race([handler({ taskName: task.name, config: task.config }), timeoutPromise]);
      const durationMs = Date.now() - start;
      const finishedAt = new Date().toISOString();
      const output = typeof result === 'string' ? result : 'completed';

      // Persist to DB (same pattern as runTask in task-runner.ts)
      dbExec(
        'INSERT INTO task_results (task_name, status, output, duration_ms, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
        task.name, 'success', output, durationMs, startedAt, finishedAt,
      );
      const rows = query<TaskResult>(
        'SELECT * FROM task_results WHERE task_name = ? ORDER BY id DESC LIMIT 1',
        task.name,
      );
      return rows[0] ?? {
        id: 0,
        task_name: task.name,
        status: 'success',
        output,
        duration_ms: durationMs,
        started_at: startedAt,
        finished_at: finishedAt,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const finishedAt = new Date().toISOString();
      const output = err instanceof Error ? err.message : String(err);

      // Persist to DB
      dbExec(
        'INSERT INTO task_results (task_name, status, output, duration_ms, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
        task.name, 'failure', output, durationMs, startedAt, finishedAt,
      );
      const rows = query<TaskResult>(
        'SELECT * FROM task_results WHERE task_name = ? ORDER BY id DESC LIMIT 1',
        task.name,
      );
      return rows[0] ?? {
        id: 0,
        task_name: task.name,
        status: 'failure',
        output,
        duration_ms: durationMs,
        started_at: startedAt,
        finished_at: finishedAt,
      };
    }
  }
}
