/**
 * External task loader — discovers and loads task handlers from configurable directories.
 *
 * Scans directories listed in `scheduler.tasks_dirs` for `.js` files that export
 * a `register(scheduler)` function, matching the same interface as built-in tasks.
 *
 * Each external task file should:
 *   export function register(scheduler: Scheduler): void {
 *     scheduler.registerHandler('my-task', async (ctx) => { ... });
 *   }
 *
 * Errors are handled gracefully — missing directories and invalid files are logged
 * and skipped without crashing the daemon.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('external-task-loader');

/** The expected export shape of an external task file. */
export interface ExternalTaskModule {
  register: (scheduler: Scheduler) => void;
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
 * Check if a module has a valid `register` export.
 */
function isValidTaskModule(mod: unknown): mod is ExternalTaskModule {
  return (
    mod !== null &&
    typeof mod === 'object' &&
    'register' in mod &&
    typeof (mod as ExternalTaskModule).register === 'function'
  );
}

/**
 * Load external task handlers from a single directory.
 *
 * Scans for `.js` files, dynamically imports each one, and calls its
 * `register(scheduler)` function if present. Invalid files are skipped
 * with warnings.
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
    try {
      // Use file:// URL for dynamic import on all platforms
      const fileUrl = new URL(`file://${filePath}`).href;
      const mod = await import(fileUrl);

      if (!isValidTaskModule(mod)) {
        log.warn('External task file missing register() export — skipping', { file: filePath });
        result.errors.push({ file: entry, error: 'Missing register() export' });
        continue;
      }

      mod.register(scheduler);
      result.loaded.push(entry);
      log.info('Loaded external task handler', { file: entry, dir: absDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to load external task file', { file: filePath, error: msg });
      result.errors.push({ file: entry, error: msg });
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
