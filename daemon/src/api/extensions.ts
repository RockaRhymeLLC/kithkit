/**
 * Extensions API — visibility and hot-reload control for the extension system.
 *
 *   GET    /api/extensions                 → main extension status + plugin list
 *   POST   /api/extensions/scan            → rescan plugins dir (load new, reload present, unload removed)
 *   POST   /api/extensions/:name/reload    → reload one plugin by name
 *   DELETE /api/extensions/:name           → unload one plugin by name
 *
 * Plugins are hot-loadable extension files (see core/plugin-extensions.ts).
 * The main compiled-in extension cannot be hot-reloaded (ESM module graph);
 * its status is reported here for completeness.
 */

import http from 'node:http';
import { json, withTimestamp } from './helpers.js';
import { getExtension, isDegraded } from '../core/extensions.js';
import { getPluginManager } from '../core/plugin-extensions.js';

export async function handleExtensionsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/extensions')) return false;
  const method = req.method ?? 'GET';
  const manager = getPluginManager();

  // GET /api/extensions
  if (pathname === '/api/extensions' && method === 'GET') {
    const ext = getExtension();
    json(res, 200, withTimestamp({
      extension: ext
        ? { name: ext.name, degraded: isDegraded(), hot_reloadable: false }
        : null,
      plugins: manager ? manager.list() : [],
      plugins_dir: manager?.dir ?? null,
    }));
    return true;
  }

  // POST /api/extensions/scan
  if (pathname === '/api/extensions/scan' && method === 'POST') {
    if (!manager) {
      json(res, 503, withTimestamp({ error: 'Plugin manager not initialized' }));
      return true;
    }
    const plugins = await manager.scan();
    json(res, 200, withTimestamp({ plugins }));
    return true;
  }

  // POST /api/extensions/:name/reload
  const reloadMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/reload$/);
  if (reloadMatch && method === 'POST') {
    if (!manager) {
      json(res, 503, withTimestamp({ error: 'Plugin manager not initialized' }));
      return true;
    }
    const name = decodeURIComponent(reloadMatch[1]!);
    const record = await manager.reload(name);
    if (!record) {
      json(res, 404, withTimestamp({ error: `Plugin not found: ${name}` }));
      return true;
    }
    json(res, record.status === 'loaded' ? 200 : 422, withTimestamp({ plugin: record }));
    return true;
  }

  // DELETE /api/extensions/:name
  const nameMatch = pathname.match(/^\/api\/extensions\/([^/]+)$/);
  if (nameMatch && method === 'DELETE') {
    if (!manager) {
      json(res, 503, withTimestamp({ error: 'Plugin manager not initialized' }));
      return true;
    }
    const name = decodeURIComponent(nameMatch[1]!);
    const removed = await manager.unload(name);
    if (!removed) {
      json(res, 404, withTimestamp({ error: `Plugin not found: ${name}` }));
      return true;
    }
    json(res, 200, withTimestamp({ unloaded: name }));
    return true;
  }

  return false;
}
