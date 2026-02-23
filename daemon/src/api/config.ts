/**
 * Config API — hot-reload endpoint.
 *
 * Routes:
 *   POST /api/config/reload — Force immediate config reload
 */

import type http from 'node:http';
import type { ConfigWatcher, ReloadResult } from '../core/config-watcher.js';
import { json, withTimestamp } from './helpers.js';

// ── State ────────────────────────────────────────────────────

let _watcher: ConfigWatcher | null = null;

export function setConfigWatcher(watcher: ConfigWatcher): void {
  _watcher = watcher;
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
