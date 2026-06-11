/**
 * Dist-Staleness Unit Tests
 *
 * Mutation-kill requirement: flipping the comparison operator
 *   distMtime < srcMtime  →  distMtime > srcMtime
 * must cause ALL stale-case assertions to fail and ALL fresh-case
 * assertions to fail (they swap results).
 *
 * Covers:
 *   - dist < src (stale)  → staleFiles non-empty, warn fired, health shows stale
 *   - dist >= src (fresh) → staleFiles empty, no warn, health shows clean
 *   - dist dir missing    → no crash, staleFiles empty
 *   - no corresponding src → file skipped
 *   - multiple files, partial staleness
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkDistStaleness,
  getDistStaleBuildState,
  _setDepsForTesting,
  _resetStateForTesting,
  type StaleBuildState,
} from '../dist-staleness.js';

// ── Helpers ────────────────────────────────────────────────────

let tmpDir: string;

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-dist-staleness-'));
  _resetStateForTesting();
  _setDepsForTesting(null); // restore real deps
}

function teardown(): void {
  _resetStateForTesting();
  _setDepsForTesting(null);
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Create a temp dist+src tree and set specific mtimes.
 *
 * @param files  Array of { relPath, distMtime, srcMtime } where:
 *               - relPath is like 'foo/bar' (no extension — .js and .ts added automatically)
 *               - distMtime / srcMtime are epoch milliseconds
 *               - srcMtime of null means no src file is created (skip test)
 */
function buildTree(files: Array<{
  relPath: string;
  distMtime: number;
  srcMtime: number | null;
}>): { distDir: string; srcDir: string } {
  const distDir = path.join(tmpDir, 'dist');
  const srcDir = path.join(tmpDir, 'src');

  for (const f of files) {
    const distFile = path.join(distDir, f.relPath + '.js');
    const srcFile  = path.join(srcDir,  f.relPath + '.ts');

    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(distFile, '// compiled');
    // Set mtime: utimesSync expects seconds
    const distSec = f.distMtime / 1000;
    fs.utimesSync(distFile, distSec, distSec);

    if (f.srcMtime !== null) {
      fs.mkdirSync(path.dirname(srcFile), { recursive: true });
      fs.writeFileSync(srcFile, '// source');
      const srcSec = f.srcMtime / 1000;
      fs.utimesSync(srcFile, srcSec, srcSec);
    }
  }

  return { distDir, srcDir };
}

// ── STALE CASE ────────────────────────────────────────────────
//
// Mutation-kill contract: if the comparison is flipped to `distMtime > srcMtime`,
// the stale case returns EMPTY staleFiles and the fresh case returns NON-EMPTY
// staleFiles. Both groups of assertions flip from pass→fail.

describe('dist-staleness: stale dist (dist older than src)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns staleFiles with the offending file', async () => {
    const now = Date.now();
    const distMtime = now - 10_000; // dist compiled 10s ago
    const srcMtime  = now - 1_000;  // src edited 1s ago — NEWER

    const { distDir, srcDir } = buildTree([
      { relPath: 'main', distMtime, srcMtime },
    ]);

    const state = await checkDistStaleness(distDir, srcDir);

    assert.strictEqual(state.staleFiles.length, 1, 'should report exactly one stale file');
    assert.ok(state.staleFiles[0].endsWith('main.js'), 'stale file should be main.js');
    assert.strictEqual(state.checked, true, 'checked flag must be set');
    assert.ok(state.checkedAt !== null, 'checkedAt must be set');
  });

  it('fires the warn log when stale', async () => {
    const now = Date.now();
    const warnCalls: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];

    _setDepsForTesting({
      logWarn: (msg, ctx) => warnCalls.push({ msg, ctx }),
    });

    const { distDir, srcDir } = buildTree([
      { relPath: 'api/handler', distMtime: now - 5_000, srcMtime: now - 500 },
    ]);

    await checkDistStaleness(distDir, srcDir);

    assert.strictEqual(warnCalls.length, 1, 'warn should fire exactly once');
    assert.ok(warnCalls[0].msg.includes('stale'), 'warn message should mention stale');
    assert.ok(
      Array.isArray((warnCalls[0].ctx as Record<string, unknown>)?.staleFiles),
      'warn context should include staleFiles array',
    );
  });

  it('getDistStaleBuildState() reflects the stale result', async () => {
    const now = Date.now();
    const { distDir, srcDir } = buildTree([
      { relPath: 'core/db', distMtime: now - 60_000, srcMtime: now - 100 },
    ]);

    await checkDistStaleness(distDir, srcDir);
    const cached = getDistStaleBuildState();

    assert.strictEqual(cached.staleFiles.length, 1, 'cached state should have one stale file');
    assert.ok(cached.staleFiles[0].endsWith('core/db.js'), 'cached stale file should be core/db.js');
  });

  it('health stale_build field shows stale:true', async () => {
    const now = Date.now();
    const { distDir, srcDir } = buildTree([
      { relPath: 'routes/health', distMtime: now - 20_000, srcMtime: now - 2_000 },
    ]);

    await checkDistStaleness(distDir, srcDir);
    const state = getDistStaleBuildState();

    // Simulate what the health endpoint does with this state
    const healthStaleBuild = state.checked
      ? { stale: state.staleFiles.length > 0, files: state.staleFiles, checked_at: state.checkedAt }
      : null;

    assert.ok(healthStaleBuild !== null, 'health stale_build should not be null after check');
    assert.strictEqual(healthStaleBuild.stale, true, 'health stale_build.stale should be true');
    assert.strictEqual(healthStaleBuild.files.length, 1, 'health stale_build.files should list the stale file');
  });
});

// ── FRESH CASE ────────────────────────────────────────────────

describe('dist-staleness: fresh dist (dist newer than or equal to src)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty staleFiles when dist is newer', async () => {
    const now = Date.now();
    const srcMtime  = now - 10_000; // src edited 10s ago
    const distMtime = now - 1_000;  // dist compiled 1s ago — NEWER

    const { distDir, srcDir } = buildTree([
      { relPath: 'main', distMtime, srcMtime },
    ]);

    const state = await checkDistStaleness(distDir, srcDir);

    assert.strictEqual(state.staleFiles.length, 0, 'should report no stale files');
    assert.strictEqual(state.checked, true);
  });

  it('returns empty staleFiles when dist mtime equals src mtime', async () => {
    const now = Date.now();
    const mtime = now - 5_000;

    const { distDir, srcDir } = buildTree([
      { relPath: 'scheduler', distMtime: mtime, srcMtime: mtime },
    ]);

    const state = await checkDistStaleness(distDir, srcDir);

    assert.strictEqual(state.staleFiles.length, 0, 'equal mtimes should not be considered stale');
  });

  it('does NOT fire the warn log when fresh', async () => {
    const now = Date.now();
    const warnCalls: Array<unknown> = [];

    _setDepsForTesting({ logWarn: () => { warnCalls.push(1); } });

    const { distDir, srcDir } = buildTree([
      { relPath: 'services/worker', distMtime: now - 1_000, srcMtime: now - 10_000 },
    ]);

    await checkDistStaleness(distDir, srcDir);

    assert.strictEqual(warnCalls.length, 0, 'warn should NOT fire when build is fresh');
  });

  it('health stale_build field shows stale:false', async () => {
    const now = Date.now();
    const { distDir, srcDir } = buildTree([
      { relPath: 'bootstrap', distMtime: now - 500, srcMtime: now - 5_000 },
    ]);

    await checkDistStaleness(distDir, srcDir);
    const state = getDistStaleBuildState();

    const healthStaleBuild = state.checked
      ? { stale: state.staleFiles.length > 0, files: state.staleFiles }
      : null;

    assert.ok(healthStaleBuild !== null);
    assert.strictEqual(healthStaleBuild.stale, false, 'health stale_build.stale should be false');
    assert.strictEqual(healthStaleBuild.files.length, 0);
  });
});

// ── EDGE CASES ────────────────────────────────────────────────

describe('dist-staleness: edge cases', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('does not crash when dist dir does not exist', async () => {
    const missing = path.join(tmpDir, 'nonexistent-dist');
    const srcDir  = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const state = await checkDistStaleness(missing, srcDir);

    assert.strictEqual(state.staleFiles.length, 0, 'missing dist dir should yield no stale files');
    assert.strictEqual(state.checked, true, 'checked should still be true');
  });

  it('skips .js files with no corresponding .ts source', async () => {
    const now = Date.now();
    // Create a dist file but NO corresponding src file
    const { distDir, srcDir } = buildTree([
      { relPath: 'generated/proto', distMtime: now - 100_000, srcMtime: null },
    ]);

    const state = await checkDistStaleness(distDir, srcDir);

    assert.strictEqual(state.staleFiles.length, 0, 'files without src should be skipped');
  });

  it('correctly identifies partial staleness (some files stale, some fresh)', async () => {
    const now = Date.now();
    const { distDir, srcDir } = buildTree([
      { relPath: 'module-a', distMtime: now - 50_000, srcMtime: now - 1_000 },  // STALE
      { relPath: 'module-b', distMtime: now - 1_000,  srcMtime: now - 50_000 }, // fresh
      { relPath: 'module-c', distMtime: now - 20_000, srcMtime: now - 500 },    // STALE
    ]);

    const state = await checkDistStaleness(distDir, srcDir);

    assert.strictEqual(state.staleFiles.length, 2, 'should identify exactly two stale files');

    const staleNames = state.staleFiles.map(f => path.basename(f));
    assert.ok(staleNames.includes('module-a.js'), 'module-a.js should be stale');
    assert.ok(staleNames.includes('module-c.js'), 'module-c.js should be stale');
    assert.ok(!staleNames.includes('module-b.js'), 'module-b.js should NOT be stale');
  });

  it('_resetStateForTesting clears checked flag and staleFiles', async () => {
    const now = Date.now();
    const { distDir, srcDir } = buildTree([
      { relPath: 'thing', distMtime: now - 10_000, srcMtime: now - 1_000 },
    ]);

    await checkDistStaleness(distDir, srcDir);
    assert.strictEqual(getDistStaleBuildState().checked, true);

    _resetStateForTesting();
    const cleared = getDistStaleBuildState();
    assert.strictEqual(cleared.checked, false, 'reset should clear checked flag');
    assert.strictEqual(cleared.staleFiles.length, 0, 'reset should clear staleFiles');
    assert.strictEqual(cleared.checkedAt, null, 'reset should clear checkedAt');
  });

  it('walks subdirectories recursively', async () => {
    const now = Date.now();
    const { distDir, srcDir } = buildTree([
      { relPath: 'deep/nested/module', distMtime: now - 10_000, srcMtime: now - 1_000 }, // STALE
    ]);

    const state = await checkDistStaleness(distDir, srcDir);

    assert.strictEqual(state.staleFiles.length, 1, 'should find stale file in nested dir');
    assert.ok(
      state.staleFiles[0].includes('deep'),
      'stale file path should include nested directories',
    );
  });
});
