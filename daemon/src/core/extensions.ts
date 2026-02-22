/**
 * Extension system — lifecycle hooks for agent repos.
 *
 * Extracted from main.ts so tests can import without triggering
 * the daemon's top-level bootstrap (config loading, DB open, server start).
 */

import http from 'node:http';
import type { KithkitConfig } from './config.js';

// ── Extension Interface ─────────────────────────────────────

/**
 * Extension interface — agent repos implement this to add capabilities.
 *
 * All methods are optional. Extensions register before server start
 * and receive lifecycle callbacks.
 */
export interface Extension {
  /** Human-readable name for logging. */
  name: string;

  /** Called after server begins listening. Async setup (adapters, tasks, etc). */
  onInit?(config: KithkitConfig, server: http.Server): Promise<void>;

  /**
   * Called for each incoming HTTP request before the 404 fallback.
   * Return true if handled, false to pass to the next handler.
   */
  onRoute?(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    searchParams: URLSearchParams,
  ): Promise<boolean>;

  /** Called during graceful shutdown, before server.close(). */
  onShutdown?(): Promise<void>;
}

// ── State ───────────────────────────────────────────────────

let _extension: Extension | null = null;
let _extensionDegraded = false;

// ── Public API ──────────────────────────────────────────────

/**
 * Register an extension. Call before the daemon starts listening.
 * Only one extension per daemon (agent entry point aggregates sub-modules).
 */
export function registerExtension(ext: Extension): void {
  if (_extension) {
    throw new Error(`Extension already registered: "${_extension.name}". Only one extension per daemon.`);
  }
  _extension = ext;
}

/**
 * Get the registered extension (if any).
 */
export function getExtension(): Extension | null {
  return _extension;
}

/**
 * Check if the daemon is running in degraded mode (extension init failed).
 */
export function isDegraded(): boolean {
  return _extensionDegraded;
}

/**
 * Mark the extension as degraded (called by main.ts when onInit throws).
 */
export function setDegraded(degraded: boolean): void {
  _extensionDegraded = degraded;
}

/** Get the registered extension (for testing). */
export function _getExtensionForTesting(): Extension | null {
  return _extension;
}

/** Reset extension state (for testing). */
export function _resetExtensionForTesting(): void {
  _extension = null;
  _extensionDegraded = false;
}
