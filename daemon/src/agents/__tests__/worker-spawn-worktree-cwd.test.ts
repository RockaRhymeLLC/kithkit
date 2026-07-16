/**
 * t-3199: Per-job git worktree cwd for branch-touching worker spawns.
 *
 * Guards the fix that auto-creates an isolated git worktree for workers whose
 * profile has branch_touching=true, so they can checkout branches without
 * mutating the shared main working tree.
 *
 * Test suite:
 *   (a) Branch-touching worker gets auto-created worktree as cwd (≠ main repo path)
 *   (b) Explicit-cwd override skips auto-create and is passed through unchanged
 *   (c) Spawn is rejected (status=failed) when worktree creation itself fails
 *
 * Mutation-kill verification (d) must be run manually per the task spec:
 *   1. Revert the effectiveCwd change in startWorker (restore `cwd: req.cwd`)
 *   2. Run this test file — test (a) MUST fail (RED)
 *   3. Restore the change — all tests pass (GREEN)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import {
  spawnWorkerJob,
  getJobStatus,
  _resetForTesting,
} from '../lifecycle.js';
import {
  _setQueryFnForTesting,
  _resetWorkersForTesting,
  _getLastSdkCallArgs,
} from '../sdk-adapter.js';
import type { AgentProfile } from '../profiles.js';

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Mock SDK query that resolves immediately with success. */
function createSuccessQuery() {
  return async function* (_args: { prompt: string; options?: unknown }) {
    await sleep(5);
    yield {
      type: 'result',
      subtype: 'success',
      result: 'Done.',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never;
  };
}

/** Initialize a minimal git repo in `dir` with one empty commit. */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
}

/** Return all worktree paths registered in the git repo at `repoDir`, with symlinks resolved. */
function listWorktreePaths(repoDir: string): string[] {
  const out = execFileSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out.split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => {
      const p = line.slice('worktree '.length).trim();
      try { return fs.realpathSync(p); } catch { return p; }
    });
}

/** Resolve symlinks in a path (macOS /var → /private/var). */
function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** Remove a git worktree and its directory. */
function removeWorktree(repoDir: string, worktreePath: string): void {
  try {
    execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath], { stdio: 'pipe' });
  } catch {
    // If the remove fails (e.g. worktree path already gone), clean up manually
  }
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Branch-touching profile ───────────────────────────────────

const BRANCH_TOUCHING_PROFILE: AgentProfile = {
  name: 'coding',
  description: 'Coding worker (branch-touching)',
  tools: [],
  disallowedTools: [],
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  maxTurns: 10,
  effort: 'high',
  body: '',
  branch_touching: true,
};

const NON_BRANCH_TOUCHING_PROFILE: AgentProfile = {
  name: 'research',
  description: 'Research worker',
  tools: [],
  disallowedTools: [],
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  maxTurns: 10,
  effort: 'high',
  body: '',
};

// ── Test suite (a) + (b): git repo present ────────────────────

describe('Branch-touching worker spawn — worktree isolation (t-3199a)', () => {
  let tmpDir: string;
  let worktreeBase: string;
  const createdWorktrees: string[] = [];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-wt-'));
    initGitRepo(tmpDir);
    worktreeBase = path.resolve(tmpDir, '..', '.kkit-worker-worktrees');

    _resetConfigForTesting();
    _resetDbForTesting();
    _resetWorkersForTesting();
    _resetForTesting();
    loadConfig(tmpDir);
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  after(async () => {
    _resetWorkersForTesting();
    _resetForTesting();
    _setQueryFnForTesting(null);
    _resetConfigForTesting();
    _resetDbForTesting();

    // Remove all worktrees before deleting the repo
    for (const wt of createdWorktrees) {
      removeWorktree(tmpDir, wt);
    }
    if (fs.existsSync(worktreeBase)) {
      fs.rmSync(worktreeBase, { recursive: true, force: true });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) branch-touching profile gets auto-created worktree cwd distinct from main repo', async () => {
    _setQueryFnForTesting(createSuccessQuery());

    const worktreesBefore = listWorktreePaths(tmpDir);

    const { jobId, status } = await spawnWorkerJob({
      profile: BRANCH_TOUCHING_PROFILE,
      prompt: 'Do branch work',
    });

    // Job must not fail synchronously (worktree creation succeeded)
    assert.notEqual(status, 'failed', `spawn must not fail synchronously; got status=${status}`);

    // Wait for runWorker to start and capture SDK args
    await sleep(100);

    const sdkArgs = _getLastSdkCallArgs();
    assert.ok(sdkArgs, 'SDK must have been called');
    const sdkCwd = (sdkArgs.options as Record<string, unknown>).cwd as string | undefined;

    assert.ok(sdkCwd, 'SDK cwd must be set for a branch-touching worker');
    assert.notEqual(realpath(sdkCwd), realpath(tmpDir), 'worker cwd must differ from the main repo path');

    // Verify the cwd is a registered git worktree (a new one, not the main repo)
    const worktreesAfter = listWorktreePaths(tmpDir);
    const newWorktrees = worktreesAfter.filter(wt => !worktreesBefore.includes(wt));
    assert.equal(newWorktrees.length, 1, `exactly one new worktree should be registered; new: ${newWorktrees.join(', ')}`);
    assert.equal(
      realpath(sdkCwd),
      newWorktrees[0],
      `SDK cwd (${sdkCwd}) must be the newly registered worktree (${newWorktrees[0]})`,
    );

    createdWorktrees.push(sdkCwd);

    // Poll timer fires every 500ms — wait for job to reach a terminal state
    await sleep(1000);
    const job = getJobStatus(jobId);
    assert.ok(['completed', 'failed'].includes(job?.status ?? ''), `job must terminate; got status=${job?.status ?? 'null'}`);
  });

  it('(b) explicit cwd override skips worktree auto-create and is passed through', async () => {
    _setQueryFnForTesting(createSuccessQuery());

    const explicitCwd = tmpDir;  // use the repo root as the explicit override
    const worktreesBefore = listWorktreePaths(tmpDir);

    const { status } = await spawnWorkerJob({
      profile: BRANCH_TOUCHING_PROFILE,
      prompt: 'Do branch work with explicit cwd',
      cwd: explicitCwd,
    });

    assert.notEqual(status, 'failed', `spawn must not fail; got status=${status}`);

    await sleep(100);

    const sdkArgs = _getLastSdkCallArgs();
    assert.ok(sdkArgs, 'SDK must have been called');
    const sdkCwd = (sdkArgs.options as Record<string, unknown>).cwd as string | undefined;

    assert.equal(sdkCwd, explicitCwd, 'explicit cwd must be passed through unchanged');

    // With an explicit cwd, no new worktrees should be created
    const worktreesAfter = listWorktreePaths(tmpDir);
    const newWorktrees = worktreesAfter.filter(wt => !worktreesBefore.includes(wt));
    assert.equal(newWorktrees.length, 0, `no new worktrees should be created; new: ${newWorktrees.join(', ')}`);

    await sleep(1000);
  });
});

// ── Test suite (c): worktree creation failure → spawn rejected ─

describe('Branch-touching spawn rejected when worktree creation fails (t-3199c)', () => {
  let tmpDir: string;

  before(async () => {
    // NOT a git repo — git worktree add will fail
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-nowt-'));

    _resetConfigForTesting();
    _resetDbForTesting();
    _resetWorkersForTesting();
    _resetForTesting();
    loadConfig(tmpDir);
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  after(async () => {
    _setQueryFnForTesting(null);
    _resetWorkersForTesting();
    _resetForTesting();
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(c) spawn returns status=failed when git worktree add fails (no git repo)', async () => {
    _setQueryFnForTesting(createSuccessQuery());

    const { jobId, status } = await spawnWorkerJob({
      profile: BRANCH_TOUCHING_PROFILE,
      prompt: 'Should fail to spawn',
    });

    // The spawn must fail because the project root is not a git repo
    assert.equal(status, 'failed', 'spawn must fail when worktree creation fails');

    const job = getJobStatus(jobId);
    assert.ok(job, 'job record must exist');
    assert.equal(job?.status, 'failed', 'job must be in failed state');
    assert.ok(job?.error, 'job must have an error message');
  });

  it('(c-b) non-branch-touching profile spawns normally in the same non-git dir', async () => {
    _setQueryFnForTesting(createSuccessQuery());

    const { status } = await spawnWorkerJob({
      profile: NON_BRANCH_TOUCHING_PROFILE,
      prompt: 'Should work fine',
    });

    // Non-branch-touching profile must not trigger worktree creation at all
    assert.notEqual(status, 'failed', 'non-branch-touching worker must spawn without error');

    await sleep(300);
  });
});
