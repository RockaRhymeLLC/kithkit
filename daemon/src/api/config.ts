/**
 * Config API — hot-reload endpoint.
 *
 * Routes:
 *   POST /api/config/reload — Force immediate config reload
 */

import { readFileSync } from 'node:fs';
import type http from 'node:http';
import yaml from 'js-yaml';
import type { ConfigWatcher, ReloadResult } from '../core/config-watcher.js';
import { json, withTimestamp } from './helpers.js';

// ── State ────────────────────────────────────────────────────

let _watcher: ConfigWatcher | null = null;
let _currentDbPath: string | undefined;
let _configFilePath: string | undefined;

export function setConfigWatcher(watcher: ConfigWatcher): void {
  _watcher = watcher;
}

export function setCurrentDbPath(dbPath: string | undefined): void {
  _currentDbPath = dbPath;
}

export function setConfigFilePath(configPath: string): void {
  _configFilePath = configPath;
}

// ── Route handler ────────────────────────────────────────────

export async function handleConfigRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // POST /api/config/reload
  if (pathname === '/api/config/reload' && method === 'POST') {
    if (!_watcher) {
      json(res, 503, withTimestamp({ error: 'Config watcher not initialized' }));
      return true;
    }

    // Guard: db_path is a restart-required field
    if (_currentDbPath !== undefined && _configFilePath) {
      try {
        const raw = readFileSync(_configFilePath, 'utf8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const daemon = parsed?.['daemon'] as Record<string, unknown> | undefined;
        const newDbPath = daemon?.['db_path'] as string | undefined;
        if (newDbPath !== undefined && newDbPath !== _currentDbPath) {
          json(res, 400, withTimestamp({
            error: 'db_path change requires daemon restart — hot-reload not supported for this field',
            current_db_path: _currentDbPath,
            requested_db_path: newDbPath,
          }));
          return true;
        }
      } catch {
        // If we can't read config to check, let the reload proceed
      }
    }

    const result: ReloadResult = _watcher.reload();

    if (result.success) {
      json(res, 200, withTimestamp({ message: 'Config reloaded successfully' }));
    } else {
      json(res, 400, withTimestamp({
        error: 'Config reload failed',
        detail: result.error,
      }));
    }
    return true;
  }

  return false;
}
