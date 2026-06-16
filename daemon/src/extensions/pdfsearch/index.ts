/**
 * PDF Search Extension — entry point.
 *
 * Initializes the SQLite schema, reads auth config from keychain,
 * and registers API routes.
 *
 * Auth: if keychain entry 'credential-pdfsearch-password' exists, Basic auth
 * is required. If missing, portal shows an open-access warning banner.
 */

import { createLogger } from '../../core/logger.js';
import { registerRoute } from '../../core/route-registry.js';
import { registerCheck } from '../../core/extended-status.js';
import { readKeychain } from '../../core/keychain.js';
import { initPdfSearchDb } from './db.js';
import { setPdfSearchPassword } from './routes.js';
import { handlePdfSearchRoute } from './routes.js';
import { startMaintenanceRecordsWatcher, stopMaintenanceRecordsWatcher } from './watcher.js';

const log = createLogger('pdfsearch');

let _initialized = false;

/**
 * Initialize the PDF Search extension.
 * Registers routes and sets up the database schema.
 */
export async function initPdfSearch(): Promise<void> {
  // Set up schema
  initPdfSearchDb();

  // Check keychain for optional password
  const password = await readKeychain('credential-pdfsearch-password');
  setPdfSearchPassword(password);

  if (password) {
    log.info('PDF Search: password auth enabled');
  } else {
    log.info('PDF Search: running in open-access mode (no password configured)');
  }

  // Register routes (wildcard + specific)
  registerRoute('/api/pdf-search/*', handlePdfSearchRoute);
  registerRoute('/api/pdf-search/folders', handlePdfSearchRoute);
  registerRoute('/api/pdf-search/status', handlePdfSearchRoute);
  registerRoute('/api/pdf-search/query', handlePdfSearchRoute);
  registerRoute('/api/pdf-search/file', handlePdfSearchRoute);
  registerRoute('/api/pdf-search/login', handlePdfSearchRoute);

  // Start maintenance records file watcher (fail-safe — never throws)
  startMaintenanceRecordsWatcher();

  // Health check
  registerCheck('pdfsearch', () => ({
    ok: _initialized,
    message: _initialized
      ? `PDF Search ready (auth: ${password ? 'enabled' : 'open'})`
      : 'PDF Search not initialized',
  }));

  _initialized = true;
  log.info('PDF Search extension initialized', { authEnabled: !!password });
}

export function stopPdfSearch(): void {
  stopMaintenanceRecordsWatcher();
  _initialized = false;
  log.info('PDF Search extension stopped');
}
