/**
 * JobsWatcher — hot-load agent-specific scheduled jobs without daemon restart.
 *
 * Watches a directory (default `.kithkit/scheduled-jobs`) for `.js` task files.
 * Supported events:
 *   - File added   → load and register the task handler
 *   - File changed → remove old handler, reload fresh (cache-busted by mtime)
 *   - File removed → remove the task and its handler from the scheduler
 *
 * Each file operation is debounced (default 300ms) to avoid double-fires from
 * editors that write a rename + write sequence.
 *
 * Per-task errors are written to `logs/agent-tasks/<task-name>.log` (append).
 * A broken file never crashes the daemon — it's logged and skipped.
 *
 * `.ts` files in the watched directory are skipped with a one-time warning.
 *
 * Usage:
 *   const watcher = new JobsWatcher(scheduler, '.kithkit/scheduled-jobs');
 *   watcher.start();
 *   // ... later ...
 *   watcher.stop();
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/logger.js';
import type { Scheduler } from './scheduler.js';
import { loadSingleFile } from './tasks/external-loader.js';

const log = createLogger('jobs-watcher');

// ── Helpers ────────────────────────────────────────────────────

/**
 * Derive a task name from a filename by stripping the `.js` extension.
 * e.g. `peer-checkin.js` → `peer-checkin`
 */
function taskNameFromFile(filename: string): string {
  return filename.replace(/\.js$/, '');
}

/**
 * Append a line to a per-task log file in `logs/agent-tasks/`.
 * Creates the directory and file if they don't exist.
 */
function appendTaskLog(logDir: string, taskName: string, message: string): void {
  try {
    const taskLogDir = path.join(logDir, 'agent-tasks');
    if (!fs.existsSync(taskLogDir)) {
      fs.mkdirSync(taskLogDir, { recursive: true });
    }
    const logFile = path.join(taskLogDir, `${taskName}.log`);
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.appendFileSync(logFile, line);
  } catch {
    // Best-effort — never crash on log failure
  }
}

// ── JobsWatcher ────────────────────────────────────────────────

export class JobsWatcher {
  private readonly _scheduler: Scheduler;
  private readonly _dir: string;
  private readonly _debounceMs: number;
  private readonly _logDir: string;
  private _watcher: fs.FSWatcher | null = null;
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _tsWarnEmitted = false;

  constructor(
    scheduler: Scheduler,
    dir = '.kithkit/scheduled-jobs',
    debounceMs = 300,
    logDir = 'logs',
  ) {
    this._scheduler = scheduler;
    this._dir = path.resolve(dir);
    this._debounceMs = debounceMs;
    this._logDir = logDir;
  }

  /**
   * Start watching the jobs directory.
   * If the directory does not exist, this is a no-op (opt-in feature).
   */
  start(): void {
    if (!fs.existsSync(this._dir)) {
      log.debug('Scheduled-jobs directory not found — hot-load disabled', { dir: this._dir });
      return;
    }

    const stat = fs.statSync(this._dir);
    if (!stat.isDirectory()) {
      log.warn('Scheduled-jobs path is not a directory — hot-load disabled', { dir: this._dir });
      return;
    }

    // Ensure the agent-task log directory exists before we start
    try {
      fs.mkdirSync(path.join(this._logDir, 'agent-tasks'), { recursive: true });
    } catch {
      // Best-effort
    }

    // Start watcher BEFORE initial scan to avoid a race where a file is added
    // between scan completion and watcher registration.
    try {
      this._watcher = fs.watch(this._dir, (event, filename) => {
        if (!filename || !filename.endsWith('.js')) {
          // Emit a one-time warning for .ts files
          if (filename && filename.endsWith('.ts') && !this._tsWarnEmitted) {
            this._tsWarnEmitted = true;
            log.warn('TypeScript files in scheduled-jobs are not supported — compile to .js first', {
              file: filename,
            });
          }
          return;
        }
        this._scheduleFileEvent(filename);
      });
      log.info('Jobs watcher started', { dir: this._dir });
    } catch (err) {
      log.error('Failed to start jobs watcher', {
        dir: this._dir,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Initial scan — load all existing .js files
    this._initialScan();
  }

  /**
   * Stop the watcher and cancel any pending debounce timers.
   */
  stop(): void {
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    log.debug('Jobs watcher stopped');
  }

  // ── Private ──────────────────────────────────────────────────

  private _initialScan(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this._dir).filter(f => f.endsWith('.js'));
    } catch (err) {
      log.error('Failed to read scheduled-jobs directory during initial scan', {
        dir: this._dir,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const filename of entries) {
      this._handleAdd(filename);
    }

    if (entries.length > 0) {
      log.info('Initial job scan complete', { dir: this._dir, files: entries.length });
    }
  }

  /**
   * Debounce file system events by filename to avoid double-fires.
   * On the debounced callback, determine the actual state of the file
   * (exists → add/change; absent → unlink) to handle edge cases where
   * the fs.watch event type and file state disagree.
   */
  private _scheduleFileEvent(filename: string): void {
    const existing = this._debounceTimers.get(filename);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._debounceTimers.delete(filename);
      const filePath = path.join(this._dir, filename);
      if (fs.existsSync(filePath)) {
        this._handleChange(filename);
      } else {
        this._handleUnlink(filename);
      }
    }, this._debounceMs);

    this._debounceTimers.set(filename, timer);
  }

  private _handleAdd(filename: string): void {
    const taskName = taskNameFromFile(filename);
    const filePath = path.join(this._dir, filename);
    log.info('Loading new job file', { file: filename, task: taskName });

    loadSingleFile(this._scheduler, filePath).then(result => {
      if (!result.loaded) {
        const msg = `Failed to load job file: ${result.error ?? 'unknown error'}`;
        log.error(msg, { file: filename });
        appendTaskLog(this._logDir, taskName, `ERROR ${msg}`);
      } else {
        appendTaskLog(this._logDir, taskName, `LOADED ${filename}`);
      }
    }).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Unexpected error loading job file', { file: filename, error: msg });
      appendTaskLog(this._logDir, taskName, `ERROR unexpected: ${msg}`);
    });
  }

  private _handleChange(filename: string): void {
    const taskName = taskNameFromFile(filename);
    const filePath = path.join(this._dir, filename);
    log.info('Reloading changed job file', { file: filename, task: taskName });

    // Remove the old registration so addTask (in loadSingleFile) doesn't no-op
    if (this._scheduler.hasHandler(taskName)) {
      this._scheduler.removeTask(taskName);
    }

    loadSingleFile(this._scheduler, filePath).then(result => {
      if (!result.loaded) {
        const msg = `Failed to reload job file: ${result.error ?? 'unknown error'}`;
        log.error(msg, { file: filename });
        appendTaskLog(this._logDir, taskName, `ERROR ${msg}`);
      } else {
        appendTaskLog(this._logDir, taskName, `RELOADED ${filename}`);
      }
    }).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Unexpected error reloading job file', { file: filename, error: msg });
      appendTaskLog(this._logDir, taskName, `ERROR unexpected: ${msg}`);
    });
  }

  private _handleUnlink(filename: string): void {
    const taskName = taskNameFromFile(filename);
    log.info('Removing unlinked job', { file: filename, task: taskName });
    this._scheduler.removeTask(taskName);
    appendTaskLog(this._logDir, taskName, `REMOVED ${filename}`);
  }
}
