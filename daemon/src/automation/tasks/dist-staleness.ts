/**
 * Dist-staleness check — detects when dist/*.js files are older than their
 * corresponding src/*.ts sources, indicating the daemon is running a stale
 * (outdated) build.
 *
 * Motivation: the Apr-16 outage occurred because the dist/ heartbeat file
 * was from a Nov-17 build while the src/ had been updated on May-17 — the
 * daemon ran months-stale compiled code until it crashed.
 *
 * Mechanism:
 *   - Walk dist/ recursively for *.js files.
 *   - For each dist/foo/bar.js, check if src/foo/bar.ts exists.
 *   - If it does and dist mtime < src mtime → stale.
 *
 * This module is called by self-watchdog on each tick. It caches the result
 * for synchronous reads by the GET /health handler.
 *
 * Warn-only: no auto-rebuild, no restart.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../core/logger.js';

const log = createLogger('self-watchdog:dist-staleness');

// ── Types ─────────────────────────────────────────────────────

export interface StaleBuildState {
  /** Whether a staleness check has run at least once since startup. */
  checked: boolean;
  /** Relative paths (from dist root) of stale dist files. Empty = fresh. */
  staleFiles: string[];
  /** ISO timestamp of the last check, or null if never checked. */
  checkedAt: string | null;
}

// ── Module-level cached state (updated on each watchdog tick) ─

let _state: StaleBuildState = {
  checked: false,
  staleFiles: [],
  checkedAt: null,
};

// ── Injectable deps (overridable for testing) ─────────────────

let _stat: (p: string) => Promise<{ mtimeMs: number }> = async (p) => {
  const s = await fs.stat(p);
  return { mtimeMs: s.mtimeMs };
};

let _readdir: (dir: string) => Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> =
  async (dir) => fs.readdir(dir, { withFileTypes: true });

let _logWarn: (msg: string, ctx?: Record<string, unknown>) => void =
  (msg, ctx) => log.warn(msg, ctx);

// ── Public API ────────────────────────────────────────────────

/**
 * Get the cached stale-build state (synchronous — safe to call from the
 * health endpoint without introducing async into the handler).
 */
export function getDistStaleBuildState(): StaleBuildState {
  return { ..._state, staleFiles: [..._state.staleFiles] };
}

/**
 * Check dist/ against src/ and update the cached state.
 *
 * Called by the self-watchdog on each scheduler tick.
 *
 * @param distDir  Absolute path to the dist directory (default: auto-detected).
 * @param srcDir   Absolute path to the src directory (default: auto-detected).
 */
export async function checkDistStaleness(
  distDir?: string,
  srcDir?: string,
): Promise<StaleBuildState> {
  const resolvedDist = distDir ?? _defaultDistDir();
  const resolvedSrc = srcDir ?? _defaultSrcDir();
  const checkedAt = new Date().toISOString();

  // If dist dir doesn't exist, skip gracefully — not a crash scenario.
  try {
    await _stat(resolvedDist);
  } catch {
    log.debug('dist-staleness: dist dir not found, skipping', { distDir: resolvedDist });
    _state = { checked: true, staleFiles: [], checkedAt };
    return { ..._state, staleFiles: [] };
  }

  let distFiles: string[];
  try {
    distFiles = await _walkJs(resolvedDist);
  } catch (err) {
    log.debug('dist-staleness: failed to walk dist dir', {
      error: err instanceof Error ? err.message : String(err),
    });
    _state = { checked: true, staleFiles: [], checkedAt };
    return { ..._state, staleFiles: [] };
  }

  const staleFiles: string[] = [];

  for (const distFile of distFiles) {
    const relPath = path.relative(resolvedDist, distFile);
    // Map dist/foo/bar.js → src/foo/bar.ts
    const srcRelPath = relPath.replace(/\.js$/, '.ts');
    const srcFile = path.join(resolvedSrc, srcRelPath);

    let distMtime: number;
    let srcMtime: number;

    try {
      distMtime = (await _stat(distFile)).mtimeMs;
    } catch {
      continue; // dist file vanished between walk and stat — skip
    }

    try {
      srcMtime = (await _stat(srcFile)).mtimeMs;
    } catch {
      continue; // no corresponding .ts source (generated file, etc.) — skip
    }

    // Stale: dist is OLDER than its source (dist mtime strictly less than src mtime)
    if (distMtime < srcMtime) {
      staleFiles.push(relPath);
    }
  }

  if (staleFiles.length > 0) {
    _logWarn('dist-staleness: stale build detected — dist files older than source', {
      staleFiles,
      count: staleFiles.length,
    });
  } else {
    log.debug('dist-staleness: build is fresh', { filesChecked: distFiles.length });
  }

  _state = { checked: true, staleFiles, checkedAt };
  return { ..._state, staleFiles: [...staleFiles] };
}

// ── Internals ─────────────────────────────────────────────────

/**
 * Resolve the default dist directory relative to this compiled file.
 * At runtime: daemon/dist/automation/tasks/dist-staleness.js
 *   ../../ → daemon/dist/
 */
function _defaultDistDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  return path.resolve(thisDir, '../../');
}

/**
 * Resolve the default src directory relative to this compiled file.
 * At runtime: daemon/dist/automation/tasks/dist-staleness.js
 *   ../../../src → daemon/src/
 */
function _defaultSrcDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  return path.resolve(thisDir, '../../../src');
}

/** Recursively collect *.js files under a directory. */
async function _walkJs(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await _readdir(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await _walkJs(fullPath);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Testing hooks ─────────────────────────────────────────────

export interface DistStalenessTestDeps {
  stat?: typeof _stat;
  readdir?: typeof _readdir;
  logWarn?: typeof _logWarn;
}

/** @internal Override injectable deps. Pass null to restore originals. */
export function _setDepsForTesting(deps: DistStalenessTestDeps | null): void {
  if (deps === null) {
    _stat = async (p) => { const s = await fs.stat(p); return { mtimeMs: s.mtimeMs }; };
    _readdir = async (dir) => fs.readdir(dir, { withFileTypes: true });
    _logWarn = (msg, ctx) => log.warn(msg, ctx);
    return;
  }
  if (deps.stat)    _stat    = deps.stat;
  if (deps.readdir) _readdir = deps.readdir;
  if (deps.logWarn) _logWarn = deps.logWarn;
}

/** @internal Reset cached state for test isolation. */
export function _resetStateForTesting(): void {
  _state = { checked: false, staleFiles: [], checkedAt: null };
}
