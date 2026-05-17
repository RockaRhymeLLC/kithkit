/**
 * External task loader — discovers and loads task handlers from configurable directories.
 *
 * Scans directories listed in `scheduler.tasks_dirs` for `.js` files that export
 * a `register(scheduler)` function, matching the same interface as built-in tasks.
 *
 * Two export shapes are supported:
 *
 *   Shape A — register function (existing pattern):
 *     export function register(scheduler: Scheduler): void {
 *       scheduler.registerHandler('my-task', async (ctx) => { ... });
 *     }
 *
 *   Shape B — default export (AgentTask / defineTask pattern):
 *     export default defineTask({
 *       name: 'my-task',
 *       schedule: { type: 'cron', expression: '0 * * * *' },
 *       async run(ctx) { ... },
 *     });
 *
 * Errors are handled gracefully — missing directories and invalid files are logged
 * and skipped without crashing the daemon.
 */

import fs, { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('external-task-loader');

// ── Types ──────────────────────────────────────────────────────

/** The expected export shape of an external task file (Shape A). */
export interface ExternalTaskModule {
  register: (scheduler: Scheduler) => void;
}

/** Shape B — default export conforming to AgentTask interface. */
export interface AgentTaskExport {
  name: string;
  schedule: { type: 'cron'; expression: string } | { type: 'interval'; ms: number };
  run: (ctx: { taskName: string; config: Record<string, unknown> }) => Promise<void>;
}

/**
 * Result of loading external tasks from a single directory.
 */
export interface LoadResult {
  dir: string;
  loaded: string[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Result of loading a single file.
 */
export interface SingleFileLoadResult {
  loaded: boolean;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Convert a millisecond duration to the string format expected by parseInterval()
 * (e.g. "1h", "30m", "45s"). Rounds sub-second values up to 1 second.
 */
function msToIntervalString(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

// ── Shape detection ────────────────────────────────────────────

function isRegisterShape(mod: unknown): mod is ExternalTaskModule {
  return (
    mod !== null &&
    typeof mod === 'object' &&
    'register' in mod &&
    typeof (mod as ExternalTaskModule).register === 'function'
  );
}

function isAgentTaskDefault(def: unknown): def is AgentTaskExport {
  return (
    def !== null &&
    typeof def === 'object' &&
    typeof (def as AgentTaskExport).name === 'string' &&
    (def as AgentTaskExport).name.length > 0 &&
    typeof (def as AgentTaskExport).run === 'function' &&
    (def as AgentTaskExport).schedule !== null &&
    typeof (def as AgentTaskExport).schedule === 'object'
  );
}

// ── Single file loader (cache-busted) ─────────────────────────

/**
 * Load (or reload) a single external task file into the scheduler.
 *
 * Uses mtime-based cache-busting so that repeated loads of a modified file
 * always get a fresh module, not the Node.js module cache.
 *
 * Supports two export shapes:
 *   - Shape A: `export function register(scheduler)` — existing pattern
 *   - Shape B: `export default { name, schedule, run }` — AgentTask pattern
 *
 * On error: logs and returns an error result; never throws.
 */
export async function loadSingleFile(
  scheduler: Scheduler,
  filePath: string,
): Promise<SingleFileLoadResult> {
  try {
    // Cache-bust via mtime so reloads always get a fresh module
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      return { loaded: false, error: `Cannot stat file: ${filePath}` };
    }

    const fileUrl = `${pathToFileURL(filePath).href}?v=${mtimeMs}`;
    const mod = await import(fileUrl);

    // ── Shape A: register(scheduler) function ──────────────────
    if (isRegisterShape(mod)) {
      mod.register(scheduler);
      log.info('Loaded external task (register shape)', { file: filePath });
      return { loaded: true };
    }

    // ── Shape B: default export AgentTask ─────────────────────
    const def = mod.default;
    if (isAgentTaskDefault(def)) {
      const { name, schedule, run } = def;

      // Build a TaskScheduleConfig from the AgentTask shape
      const taskConfig =
        schedule.type === 'cron'
          ? { name, enabled: true, cron: schedule.expression, config: {} }
          : { name, enabled: true, interval: msToIntervalString(schedule.ms), config: {} };

      // addTask is idempotent — safe to call on reload path after removeTask
      scheduler.addTask(taskConfig);
      scheduler.registerHandler(name, ctx => run(ctx));
      log.info('Loaded external task (default-export shape)', { file: filePath, task: name });
      return { loaded: true };
    }

    log.warn('External task file has no valid export — skipping', { file: filePath });
    return { loaded: false, error: 'No valid task export (expected register() or default AgentTask)' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Failed to load external task file', { file: filePath, error: msg });
    return { loaded: false, error: msg };
  }
}

// ── Directory loader ───────────────────────────────────────────

/**
 * Load external task handlers from a single directory.
 *
 * Scans for `.js` files, dynamically imports each one, and processes the
 * recognised export shape. Invalid files are skipped with warnings.
 */
async function loadFromDirectory(
  dir: string,
  scheduler: Scheduler,
): Promise<LoadResult> {
  const result: LoadResult = { dir, loaded: [], errors: [] };

  // Resolve to absolute path
  const absDir = path.resolve(dir);

  // Check directory exists
  if (!fs.existsSync(absDir)) {
    log.warn('External tasks directory not found — skipping', { dir: absDir });
    return result;
  }

  const stat = fs.statSync(absDir);
  if (!stat.isDirectory()) {
    log.warn('External tasks path is not a directory — skipping', { dir: absDir });
    return result;
  }

  // Read .js files from directory
  let entries: string[];
  try {
    entries = fs.readdirSync(absDir).filter(f => f.endsWith('.js'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Failed to read external tasks directory', { dir: absDir, error: msg });
    result.errors.push({ file: absDir, error: msg });
    return result;
  }

  if (entries.length === 0) {
    log.debug('No .js files found in external tasks directory', { dir: absDir });
    return result;
  }

  // Import each file
  for (const entry of entries) {
    const filePath = path.join(absDir, entry);
    const fileResult = await loadSingleFile(scheduler, filePath);
    if (fileResult.loaded) {
      result.loaded.push(entry);
    } else {
      result.errors.push({ file: entry, error: fileResult.error ?? 'Unknown error' });
    }
  }

  return result;
}

/**
 * Load external task handlers from all configured directories.
 *
 * @param dirs Array of directory paths to scan for task files.
 * @param scheduler The scheduler instance to register handlers with.
 * @returns Array of load results, one per directory.
 */
export async function loadExternalTasks(
  dirs: string[],
  scheduler: Scheduler,
): Promise<LoadResult[]> {
  if (!dirs || dirs.length === 0) {
    return [];
  }

  log.info('Loading external tasks', { dirs });

  const results: LoadResult[] = [];
  for (const dir of dirs) {
    const result = await loadFromDirectory(dir, scheduler);
    results.push(result);
  }

  // Summary log
  const totalLoaded = results.reduce((sum, r) => sum + r.loaded.length, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  if (totalLoaded > 0 || totalErrors > 0) {
    log.info('External task loading complete', { loaded: totalLoaded, errors: totalErrors });
  }

  return results;
}
