/**
 * Granola Extension — entry point.
 *
 * Wires: routes, scheduler handler, key check on init.
 * Non-fatal: if API key is missing or extension is disabled, logs a warning and returns.
 */

import http from 'node:http';
import type { KithkitConfig } from '../../core/config.js';
import type { Scheduler } from '../../automation/scheduler.js';
import { registerRoute, unregisterRoute } from '../../core/route-registry.js';
import { createLogger } from '../../core/logger.js';
import { getGranolaConfig } from './config.js';
import { getKey } from './client.js';
import { updateSyncState } from './store.js';
import { createSyncHandler } from './scheduler.js';
import { EXTRACT_TASK_NAME, register as registerExtractHandler } from './extract-task.js';
import {
  setConfig,
  handleGranolaStatus,
  handleGranolaNotes,
  handleGranolaNoteById,
  handleGranolaSync,
  handleGranolaCandidates,
  handleGranolaCandidateAction,
} from './routes.js';

const log = createLogger('granola-extension');

const SYNC_TASK_NAME = 'granola-sync';

/** Routes this extension registers — unregistered on shutdown so the
 * extension can be hot-reloaded as a plugin without route collisions. */
const GRANOLA_ROUTES: Array<[string, Parameters<typeof registerRoute>[1]]> = [
  ['/api/granola/status', handleGranolaStatus],
  ['/api/granola/notes', handleGranolaNotes],
  // Exact match for list endpoint (must come before wildcard catch-all)
  ['/api/granola/candidates', handleGranolaCandidates],
  // Wildcard catch-all for /api/granola/candidates/:id/:action
  ['/api/granola/candidates/*', handleGranolaCandidateAction],
  ['/api/granola/sync', handleGranolaSync],
  // Note: /api/granola/notes/:id — must come after /api/granola/notes wildcard
  ['/api/granola/notes/*', handleGranolaNoteById],
];

let _routesRegistered = false;

export async function initGranolaExtension(
  config: KithkitConfig,
  _server: http.Server,
  scheduler: Scheduler,
): Promise<void> {
  const granolaConfig = getGranolaConfig(config);

  if (!granolaConfig.enabled) {
    log.info('Granola extension disabled in config — skipping init');
    return;
  }

  // Verify API key presence at startup
  const apiKey = await getKey();
  if (!apiKey) {
    log.warn(
      'Granola API key not found in Keychain (service: credential-granola-api, account: assistant) — ' +
      'extension disabled for this run',
    );
    updateSyncState({ last_sync_status: 'disabled', last_error: 'API key not found in Keychain' });
    return;
  }

  // Share config with routes module
  setConfig(granolaConfig);

  // Register HTTP routes (tracked in GRANOLA_ROUTES; torn down in shutdown)
  for (const [pattern, handler] of GRANOLA_ROUTES) {
    registerRoute(pattern, handler);
  }
  _routesRegistered = true;

  // Register sync handler
  try {
    const syncHandler = createSyncHandler(granolaConfig);
    scheduler.registerHandler(SYNC_TASK_NAME, async () => { await syncHandler(); });
    log.info('Granola sync handler registered', { task: SYNC_TASK_NAME });
  } catch (err) {
    // Task not in config — log but don't fail (routes still work, manual sync still works)
    log.warn(`Could not register scheduler handler for "${SYNC_TASK_NAME}" — task may not be in config`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Register extract handler (needs-extraction list pattern)
  try {
    registerExtractHandler(scheduler, granolaConfig);
    log.info('Granola extract handler registered', { task: EXTRACT_TASK_NAME });
  } catch (err) {
    log.warn(`Could not register scheduler handler for "${EXTRACT_TASK_NAME}" — task may not be in config`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('Granola extension initialized', {
    apiBase: granolaConfig.api_base_url,
    extractionEnabled: granolaConfig.extraction_enabled,
    pollIntervalMin: granolaConfig.poll_interval_minutes,
  });
}

export async function shutdownGranolaExtension(): Promise<void> {
  // Unregister routes so a hot-reload (plugin path) can re-register them
  // without collisions. Scheduler handlers are managed externally and
  // registerHandler overwrites on re-register, so they need no teardown.
  if (_routesRegistered) {
    for (const [pattern] of GRANOLA_ROUTES) {
      unregisterRoute(pattern);
    }
    _routesRegistered = false;
  }
  log.debug('Granola extension shutdown');
}
