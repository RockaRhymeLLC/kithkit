/**
 * Sync-Claude API — POST /api/sync/claude
 *
 * One-directional sync: .kithkit/ → .claude/
 * Copies .kithkit/settings.json → .claude/settings.json
 * Copies .kithkit/CLAUDE.md    → .claude/CLAUDE.md
 * Rsyncs .kithkit/agents/      → .claude/agents/ (with --delete)
 * Rsyncs .kithkit/skills/      → .claude/skills/ (with --delete)
 *
 * Returns a summary of files synced, bytes written, and any errors.
 * Missing source files/directories produce a warning, not an error.
 */

import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { resolveProjectPath } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { json, withTimestamp } from './helpers.js';

const log = createLogger('sync-claude');

interface SyncFileResult {
  file: string;
  status: 'synced' | 'skipped' | 'error';
  bytes?: number;
  had_drift?: boolean;
  error?: string;
}

interface SyncResult {
  files: SyncFileResult[];
  synced: number;
  skipped: number;
  errors: number;
}

/** The files that are synced: source (in .kithkit/) → dest (in .claude/) */
const SYNC_PAIRS: Array<{ src: string; dst: string }> = [
  { src: '.kithkit/settings.json', dst: '.claude/settings.json' },
  { src: '.kithkit/CLAUDE.md',     dst: '.claude/CLAUDE.md' },
];

/** Directory sync pairs — use rsync --delete for these */
const DIR_SYNC_PAIRS: Array<{ src: string; dst: string; label: string }> = [
  { src: '.kithkit/agents', dst: '.claude/agents', label: 'agents' },
  { src: '.kithkit/skills', dst: '.claude/skills', label: 'skills' },
];

/**
 * Perform the sync operation and return a result summary.
 */
export function syncClaudeFiles(): SyncResult {
  const results: SyncFileResult[] = [];
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  // ── File sync ──────────────────────────────────────────────

  for (const { src, dst } of SYNC_PAIRS) {
    const srcPath = resolveProjectPath(src);
    const dstPath = resolveProjectPath(dst);

    // Source missing — warn and skip
    if (!fs.existsSync(srcPath)) {
      log.warn('Source file missing — skipping sync', { src: srcPath });
      results.push({ file: src, status: 'skipped', error: 'source file not found' });
      skipped++;
      continue;
    }

    try {
      const srcContent = fs.readFileSync(srcPath);

      // Drift detection — compare before writing
      let hadDrift = false;
      if (fs.existsSync(dstPath)) {
        const dstContent = fs.readFileSync(dstPath);
        if (!srcContent.equals(dstContent)) {
          hadDrift = true;
          log.warn('Drift detected — destination differs from source', {
            src: path.basename(srcPath),
            srcBytes: srcContent.length,
            dstBytes: dstContent.length,
          });
        }
      }

      // Ensure destination directory exists
      const dstDir = path.dirname(dstPath);
      fs.mkdirSync(dstDir, { recursive: true });

      // Write
      fs.writeFileSync(dstPath, srcContent);
      log.info('Synced', { src, dst, bytes: srcContent.length, had_drift: hadDrift });

      results.push({
        file: src,
        status: 'synced',
        bytes: srcContent.length,
        had_drift: hadDrift,
      });
      synced++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Sync failed', { src, dst, error: msg });
      results.push({ file: src, status: 'error', error: msg });
      errors++;
    }
  }

  // ── Directory sync (rsync --delete) ───────────────────────

  for (const { src, dst, label } of DIR_SYNC_PAIRS) {
    const srcPath = resolveProjectPath(src);
    const dstPath = resolveProjectPath(dst);

    // Source missing — warn and skip
    if (!fs.existsSync(srcPath)) {
      log.warn('Source directory missing — skipping sync', { src: srcPath });
      results.push({ file: src + '/', status: 'skipped', error: 'source directory not found' });
      skipped++;
      continue;
    }

    // Guard against empty source wiping destination
    const entries = fs.readdirSync(srcPath);
    if (entries.length === 0) {
      log.warn('Source directory is empty — skipping sync to avoid wiping destination', { src: srcPath });
      results.push({ file: src + '/', status: 'skipped', error: 'source directory is empty' });
      skipped++;
      continue;
    }

    try {
      // Ensure destination directory exists
      fs.mkdirSync(dstPath, { recursive: true });

      // rsync: trailing slash on src copies contents into dst
      execSync(`rsync -a --delete "${srcPath}/" "${dstPath}/"`, { stdio: 'pipe' });
      log.info('Synced directory', { src, dst, label });

      results.push({ file: src + '/', status: 'synced' });
      synced++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Directory sync failed', { src, dst, label, error: msg });
      results.push({ file: src + '/', status: 'error', error: msg });
      errors++;
    }
  }

  return { files: results, synced, skipped, errors };
}

/**
 * Route handler for POST /api/sync/claude.
 * Returns true if it handled the request, false otherwise.
 */
export async function handleSyncClaudeRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/sync/claude') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    json(res, 405, withTimestamp({ error: 'Method not allowed — use POST' }));
    return true;
  }

  const result = syncClaudeFiles();
  const status = result.errors > 0 ? 207 : 200;
  json(res, status, withTimestamp(result));
  return true;
}
