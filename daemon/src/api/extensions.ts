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
 *
 * SECURITY — load-authorization gate on every mutating endpoint:
 * loading a plugin executes arbitrary code IN the daemon process, so the
 * mutating endpoints are an arbitrary-code-load surface. The localhost-only
 * bind is NOT a sufficient boundary for that — any local process (including
 * sandboxed workers with Bash) can reach 127.0.0.1. Mutating calls therefore
 * require an X-Agent-Token with role 'comms' or 'daemon' (same gate family
 * as /api/send): a worker that can write a plugin file still cannot make the
 * daemon LOAD it. Note the manager only ever loads operator-placed files
 * from its one configured directory — no endpoint accepts file paths or
 * content. GET (read-only status) stays open like other status endpoints.
 */

import http from 'node:http';
import path from 'node:path';
import { json, withTimestamp } from './helpers.js';
import { getExtension, isDegraded } from '../core/extensions.js';
import { getPluginManager, PluginRecord } from '../core/plugin-extensions.js';
import { verifyToken } from '../auth/agent-tokens.js';

/** Strip the absolute file path from a PluginRecord — expose only the basename. */
function sanitizePlugin(record: PluginRecord): PluginRecord & { file: string } {
  return { ...record, file: path.basename(record.file) };
}

/** Gate mutating extension-management calls to comms/daemon roles. */
function checkManagementAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const rawHeader = req.headers['x-agent-token'];
  const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!token) {
    json(res, 401, withTimestamp({ error: 'X-Agent-Token header required for extension management' }));
    return false;
  }
  const identity = verifyToken(token);
  if (!identity) {
    json(res, 401, withTimestamp({ error: 'Invalid or revoked agent token' }));
    return false;
  }
  if (identity.role !== 'comms' && identity.role !== 'daemon') {
    json(res, 403, withTimestamp({
      error: 'Extension management requires the comms or daemon role — plugin load executes code in the daemon process.',
      role: identity.role,
    }));
    return false;
  }
  return true;
}

export async function handleExtensionsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/extensions')) return false;
  const method = req.method ?? 'GET';
  const manager = getPluginManager();

  // Every mutating method on this surface is gated before any routing.
  if (method !== 'GET' && !checkManagementAuth(req, res)) {
    return true;
  }

  // GET /api/extensions
  if (pathname === '/api/extensions' && method === 'GET') {
    const ext = getExtension();
    json(res, 200, withTimestamp({
      extension: ext
        ? { name: ext.name, degraded: isDegraded(), hot_reloadable: false }
        : null,
      plugins: manager ? manager.list().map(sanitizePlugin) : [],
      plugins_dir_configured: manager != null,
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
    json(res, 200, withTimestamp({ plugins: plugins.map(sanitizePlugin) }));
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
    json(res, record.status === 'loaded' ? 200 : 422, withTimestamp({ plugin: sanitizePlugin(record) }));
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
