/**
 * Sync API — copy framework files from .kithkit/ (source of truth) to .claude/.
 *
 * Claude Code reads CLAUDE.md and settings.json from .claude/. The .kithkit/
 * directory is the versioned source of truth for framework-owned files.
 * This endpoint syncs those files back to .claude/ on demand.
 *
 * Route:
 *   POST /api/sync/claude — sync CLAUDE.md, settings.json, settings.local.json
 *
 * Response shape:
 *   { synced: string[], timestamp: string }
 */

import type http from 'node:http';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectPath } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { json } from './helpers.js';

const log = createLogger('sync');

/**
 * Handle POST /api/sync/claude.
 * Returns true if the route matched and was handled, false otherwise.
 */
export function handleSyncRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): boolean {
  if (pathname !== '/api/sync/claude' || req.method !== 'POST') return false;

  const kithkitDir = resolveProjectPath('.kithkit');
  const claudeDir = resolveProjectPath('.claude');

  if (!existsSync(kithkitDir)) {
    json(res, 404, { error: '.kithkit directory not found' });
    return true;
  }

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const synced: string[] = [];
  const files = ['CLAUDE.md', 'settings.json', 'settings.local.json'];

  for (const file of files) {
    const src = join(kithkitDir, file);
    const dst = join(claudeDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      synced.push(file);
      log.info(`Synced ${file} from .kithkit/ to .claude/`);
    }
  }

  json(res, 200, { synced, timestamp: new Date().toISOString() });
  return true;
}
