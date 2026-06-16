/**
 * PDF Search — Maintenance Records file watcher.
 *
 * Watches /Users/marvho/Documents/HomeData/Flying/N413CT/Maintenance Records
 * recursively for new or changed .pdf files and triggers an incremental reindex
 * of pdfsearch folder id 2 (resolved dynamically from DB; falls back to 2).
 *
 * Implementation note: the task spec referenced chokidar, but it is not installed
 * in the project and config-watcher.ts uses Node.js built-in fs.watch() directly.
 * This module follows the same pattern and uses fs.watch({ recursive: true }),
 * which is fully supported on macOS (darwin) in Node.js 22+.
 *
 * Fail-safe: if the directory does not exist or the watcher errors, a warning is
 * logged and the daemon continues normally — the watcher is never a hard dependency.
 */

import fs from 'node:fs';
import { createLogger } from '../../core/logger.js';
import { getFolderByPath, getFolder } from './db.js';
import { indexFolder, isIndexing } from './indexer.js';

const log = createLogger('pdfsearch-watcher');

const WATCH_PATH = '/Users/marvho/Documents/HomeData/Flying/N413CT/Maintenance Records';
const FOLDER_ID_FALLBACK = 2;
const DEBOUNCE_MS = 7_000; // coalesce rapid bursts (e.g., iCloud sync touching many files)

let _watcher: fs.FSWatcher | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ── Folder resolution ─────────────────────────────────────────

/**
 * Resolve the pdfsearch Folder record for the maintenance records path.
 * Tries DB lookup first; falls back to numeric id 2.
 * Returns null if neither is available (DB not ready, tables absent, etc.).
 */
function resolveFolder() {
  try {
    const byPath = getFolderByPath(WATCH_PATH);
    if (byPath) return byPath;

    const byId = getFolder(FOLDER_ID_FALLBACK);
    return byId ?? null;
  } catch {
    // pdfsearch tables may not exist yet (extension not registered or DB not ready)
    return null;
  }
}

// ── Reindex trigger ───────────────────────────────────────────

async function triggerReindex(): Promise<void> {
  const folder = resolveFolder();
  if (!folder) {
    log.warn('Maintenance records folder not found in pdfsearch DB — skipping triggered reindex', {
      watchPath: WATCH_PATH,
      fallbackId: FOLDER_ID_FALLBACK,
    });
    return;
  }

  if (isIndexing()) {
    log.debug('Indexer already running — skipping triggered reindex (will catch up on next change)');
    return;
  }

  log.info('PDF file change detected — triggering incremental reindex', { folderId: folder.id, path: folder.path });

  indexFolder(folder).catch(err => {
    log.error('Triggered reindex failed', {
      folderId: folder.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function scheduleReindex(): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    triggerReindex();
  }, DEBOUNCE_MS);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Start watching the maintenance records directory for PDF changes.
 * Idempotent — calling multiple times is safe (subsequent calls are no-ops).
 * Never throws — all errors are logged as warnings.
 */
export function startMaintenanceRecordsWatcher(): void {
  if (_watcher) return; // already running

  // Verify path exists and is a directory before attaching watcher
  let dirExists = false;
  try {
    const stat = fs.statSync(WATCH_PATH);
    dirExists = stat.isDirectory();
  } catch {
    // path doesn't exist (iCloud not synced, drive not mounted, etc.)
  }

  if (!dirExists) {
    log.warn('Maintenance records path not found — file watcher not started (will not auto-reindex on new PDFs)', {
      path: WATCH_PATH,
    });
    return;
  }

  try {
    _watcher = fs.watch(WATCH_PATH, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) return;

      // Only react to PDF files
      if (!filename.toLowerCase().endsWith('.pdf')) return;

      log.debug('PDF filesystem event', { filename });
      scheduleReindex();
    });

    _watcher.on('error', (err) => {
      log.warn('Maintenance records watcher error', {
        path: WATCH_PATH,
        error: err.message,
      });
      // Don't attempt restart — let the operator fix the underlying issue
    });

    log.info('Maintenance records watcher started', {
      path: WATCH_PATH,
      debounceMs: DEBOUNCE_MS,
    });
  } catch (err) {
    log.warn('Failed to start maintenance records watcher — daemon continues without auto-reindex', {
      path: WATCH_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Stop the watcher and cancel any pending debounced reindex.
 * Called during daemon shutdown.
 */
export function stopMaintenanceRecordsWatcher(): void {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_watcher) {
    try {
      _watcher.close();
    } catch {
      // ignore close errors during shutdown
    }
    _watcher = null;
    log.info('Maintenance records watcher stopped');
  }
}
