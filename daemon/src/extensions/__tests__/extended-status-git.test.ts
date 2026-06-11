/**
 * t-276: getGitStatus() derives commits-behind live via fetch + rev-list
 *
 * Verifies that:
 *   - getGitStatus() calls `git fetch origin main` before counting
 *   - behindOfOrigin is populated from `git rev-list --count HEAD..origin/main`
 *   - aheadOfOrigin is populated from `git rev-list --count origin/main..HEAD`
 *   - When fetch fails, fetchFailed is set to true and counts are still returned
 *     (based on the cached ref — stale but non-crashing)
 *   - behindOfOrigin is never sourced from a passed-in or cached value; it always
 *     reflects the output of the rev-list command at call time
 *
 * Uses the _setExecForTesting() seam to avoid real git/network I/O.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { getGitStatus, _setExecForTesting } from '../extended-status.js';

// ── Helpers ──────────────────────────────────────────────────

let tmpDir: string;

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-status-git-test-'));
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    'agent:\n  name: test-agent\ndaemon:\n  log_dir: logs\n',
  );
  _resetConfigForTesting();
  loadConfig(tmpDir);
}

function teardown(): void {
  _setExecForTesting(null);
  _resetConfigForTesting();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Build a mock exec that records every call and returns predetermined results.
type CallRecord = { file: string; args: string[] };

function makeMockExec(opts: {
  fetchShouldFail?: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
}): { calls: CallRecord[]; exec: Parameters<typeof _setExecForTesting>[0] } {
  const calls: CallRecord[] = [];
  const exec = async (file: string, args: string[], _opts: unknown) => {
    calls.push({ file, args });

    // `git fetch origin main …`
    if (args[0] === 'fetch') {
      if (opts.fetchShouldFail) throw new Error('network unreachable');
      return { stdout: '' };
    }
    // `git rev-parse --abbrev-ref HEAD`
    if (args.includes('--abbrev-ref')) {
      return { stdout: (opts.branch ?? 'main') + '\n' };
    }
    // `git rev-list --count origin/main..HEAD`  (ahead)
    if (args.includes('origin/main..HEAD')) {
      return { stdout: String(opts.ahead ?? 0) + '\n' };
    }
    // `git rev-list --count HEAD..origin/main`  (behind)
    if (args.includes('HEAD..origin/main')) {
      return { stdout: String(opts.behind ?? 0) + '\n' };
    }
    // `git status --porcelain`
    if (args.includes('--porcelain')) {
      return { stdout: opts.dirty ? 'M file.ts\n' : '' };
    }
    return { stdout: '' };
  };
  return { calls, exec: exec as Parameters<typeof _setExecForTesting>[0] };
}

// ── Tests ────────────────────────────────────────────────────

describe('getGitStatus() live divergence (t-276)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns behindOfOrigin from HEAD..origin/main rev-list output', async () => {
    const { exec } = makeMockExec({ ahead: 3, behind: 32, branch: 'main' });
    _setExecForTesting(exec);

    const status = await getGitStatus();
    assert.ok(status, 'should return a status object');
    assert.equal(status.behindOfOrigin, 32, 'behindOfOrigin must match rev-list output');
    assert.equal(status.aheadOfOrigin, 3, 'aheadOfOrigin must match rev-list output');
    assert.equal(status.branch, 'main');
    assert.equal(status.dirty, false);
    assert.ok(!status.fetchFailed, 'fetchFailed should not be set when fetch succeeds');
  });

  it('calls git fetch before rev-list (fetch-before-count invariant)', async () => {
    const { calls, exec } = makeMockExec({ ahead: 0, behind: 5 });
    _setExecForTesting(exec);

    await getGitStatus();

    const fetchIdx = calls.findIndex(c => c.args[0] === 'fetch');
    const behindIdx = calls.findIndex(c => c.args.includes('HEAD..origin/main'));

    assert.ok(fetchIdx !== -1, 'git fetch must be called');
    assert.ok(behindIdx !== -1, 'git rev-list HEAD..origin/main must be called');
    assert.ok(fetchIdx < behindIdx, 'fetch must happen before rev-list (behind count)');
  });

  it('sets fetchFailed and still returns counts when fetch fails', async () => {
    const { exec } = makeMockExec({ fetchShouldFail: true, ahead: 1, behind: 16 });
    _setExecForTesting(exec);

    const status = await getGitStatus();
    assert.ok(status, 'should return a status object even when fetch fails');
    assert.equal(status.fetchFailed, true, 'fetchFailed must be true when fetch throws');
    // Counts are still derived from rev-list (using cached ref) — not zero, not undefined
    assert.equal(typeof status.behindOfOrigin, 'number');
    assert.equal(typeof status.aheadOfOrigin, 'number');
  });

  it('does not crash when rev-list fails (returns 0 gracefully)', async () => {
    const calls: CallRecord[] = [];
    _setExecForTesting(async (file, args) => {
      calls.push({ file, args });
      if (args[0] === 'fetch') return { stdout: '' };
      if (args.includes('--abbrev-ref')) return { stdout: 'main\n' };
      if (args.includes('--porcelain')) return { stdout: '' };
      // Both rev-list calls throw
      throw new Error('fatal: not a git repository');
    });

    const status = await getGitStatus();
    assert.ok(status, 'should still return a partial result');
    assert.equal(status.aheadOfOrigin, 0);
    assert.equal(status.behindOfOrigin, 0);
  });

  it('dirty flag reflects git status --porcelain output', async () => {
    const { exec } = makeMockExec({ dirty: true, behind: 0 });
    _setExecForTesting(exec);

    const status = await getGitStatus();
    assert.ok(status);
    assert.equal(status.dirty, true);
  });
});
