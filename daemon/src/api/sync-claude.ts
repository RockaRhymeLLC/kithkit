/**
 * Sync-Claude API — POST /api/sync/claude
 *
 * One-directional sync: .kithkit/ → .claude/
 * Merges .kithkit/settings.json  → .claude/settings.json (JSON merge, see below)
 * Copies .kithkit/CLAUDE.md      → .claude/CLAUDE.md
 * Rsyncs .kithkit/agents/        → .claude/agents/ (with --delete)
 * Rsyncs .kithkit/skills/        → .claude/skills/ (with --delete)
 *
 * settings.json merge strategy (preserves instance-specific content):
 *   - Source keys win over destination for all non-hook keys (e.g. statusLine)
 *   - Destination-only top-level keys are preserved (e.g. the `permissions` block)
 *   - Hook event arrays are merged: source hooks take precedence, then destination
 *     hooks whose `command` doesn't appear in the source list are appended.
 *     This ensures instance-specific hooks (session-start, branch-guard, etc.)
 *     survive sync even if they aren't in .kithkit/settings.json.
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
const SYNC_PAIRS: Array<{ src: string; dst: string; merge?: boolean }> = [
  { src: '.kithkit/settings.json', dst: '.claude/settings.json', merge: true },
  { src: '.kithkit/CLAUDE.md',     dst: '.claude/CLAUDE.md' },
];

/** Directory sync pairs — use rsync --delete for these */
const DIR_SYNC_PAIRS: Array<{ src: string; dst: string; label: string }> = [
  { src: '.kithkit/agents', dst: '.claude/agents', label: 'agents' },
  { src: '.kithkit/skills', dst: '.claude/skills', label: 'skills' },
];

/**
 * A single hook entry inside a hook event array.
 * Shape: { matcher?: string, hooks: Array<{ type, command, ... }> }
 */
type HookEntry = Record<string, unknown>;

/**
 * Extract the `command` string from a hook entry's inner hooks array.
 * Used for deduplication when merging hook lists.
 */
function hooksCommands(entry: HookEntry): Set<string> {
  const cmds = new Set<string>();
  const inner = entry['hooks'];
  if (Array.isArray(inner)) {
    for (const h of inner) {
      if (h && typeof h === 'object' && typeof (h as Record<string, unknown>)['command'] === 'string') {
        cmds.add((h as Record<string, unknown>)['command'] as string);
      }
    }
  }
  return cmds;
}

/**
 * Merge two settings.json objects.
 *
 * Rules:
 *   1. Source top-level keys win over destination (source is authoritative).
 *   2. Destination-only top-level keys are preserved (e.g. `permissions`).
 *   3. For the `hooks` object, each event key's array is merged:
 *      - All source entries are kept first (order preserved).
 *      - Destination entries whose commands don't appear in any source entry
 *        are appended (instance-specific hooks survive sync).
 *
 * Exported for unit testing.
 */
export function mergeSettings(
  src: Record<string, unknown>,
  dst: Record<string, unknown>,
): Record<string, unknown> {
  // Start from a shallow copy of dst (preserves destination-only keys like `permissions`)
  const merged: Record<string, unknown> = { ...dst };

  // Apply source keys on top (source wins for non-hooks keys)
  for (const [key, srcVal] of Object.entries(src)) {
    if (key !== 'hooks') {
      merged[key] = srcVal;
    }
  }

  // Merge hooks
  const srcHooks = (src['hooks'] as Record<string, unknown[]> | undefined) ?? {};
  const dstHooks = (dst['hooks'] as Record<string, unknown[]> | undefined) ?? {};
  const mergedHooks: Record<string, unknown[]> = {};

  // Collect all event keys from both
  const allEvents = new Set([...Object.keys(srcHooks), ...Object.keys(dstHooks)]);

  for (const event of allEvents) {
    const srcEntries = (srcHooks[event] ?? []) as HookEntry[];
    const dstEntries = (dstHooks[event] ?? []) as HookEntry[];

    // Build set of all commands already present in source entries
    const srcCommands = new Set<string>();
    for (const entry of srcEntries) {
      for (const cmd of hooksCommands(entry)) {
        srcCommands.add(cmd);
      }
    }

    // Append destination entries whose commands don't exist in source
    const extra: HookEntry[] = [];
    for (const entry of dstEntries) {
      const cmds = hooksCommands(entry);
      // If none of this entry's commands are in the source set, keep it
      const hasOverlap = [...cmds].some((c) => srcCommands.has(c));
      if (!hasOverlap) {
        extra.push(entry);
      }
    }

    mergedHooks[event] = [...srcEntries, ...extra];
  }

  merged['hooks'] = mergedHooks;
  return merged;
}

/**
 * Perform the sync operation and return a result summary.
 */
export function syncClaudeFiles(): SyncResult {
  const results: SyncFileResult[] = [];
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  // ── File sync ──────────────────────────────────────────────

  for (const { src, dst, merge } of SYNC_PAIRS) {
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
      const srcBuffer = fs.readFileSync(srcPath);

      // For settings.json: merge with existing destination rather than overwrite
      let writeBuffer: Buffer;
      let hadDrift = false;

      if (merge && fs.existsSync(dstPath)) {
        const dstBuffer = fs.readFileSync(dstPath);
        hadDrift = !srcBuffer.equals(dstBuffer);

        if (hadDrift) {
          log.warn('Drift detected — merging settings.json', {
            srcBytes: srcBuffer.length,
            dstBytes: dstBuffer.length,
          });
        }

        try {
          const srcObj = JSON.parse(srcBuffer.toString('utf8')) as Record<string, unknown>;
          const dstObj = JSON.parse(dstBuffer.toString('utf8')) as Record<string, unknown>;
          const merged = mergeSettings(srcObj, dstObj);
          writeBuffer = Buffer.from(JSON.stringify(merged, null, 2) + '\n', 'utf8');
        } catch (parseErr) {
          // If either file is invalid JSON, fall back to full overwrite
          log.warn('JSON parse error during merge — falling back to full overwrite', {
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
          writeBuffer = srcBuffer;
        }
      } else {
        // No existing destination, or not a merge file — plain copy
        if (fs.existsSync(dstPath)) {
          const dstBuffer = fs.readFileSync(dstPath);
          hadDrift = !srcBuffer.equals(dstBuffer);
          if (hadDrift) {
            log.warn('Drift detected — destination differs from source', {
              src: path.basename(srcPath),
              srcBytes: srcBuffer.length,
              dstBytes: dstBuffer.length,
            });
          }
        }
        writeBuffer = srcBuffer;
      }

      // Ensure destination directory exists
      const dstDir = path.dirname(dstPath);
      fs.mkdirSync(dstDir, { recursive: true });

      // Write
      fs.writeFileSync(dstPath, writeBuffer);
      log.info('Synced', { src, dst, bytes: writeBuffer.length, had_drift: hadDrift, merged: merge ?? false });

      results.push({
        file: src,
        status: 'synced',
        bytes: writeBuffer.length,
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
