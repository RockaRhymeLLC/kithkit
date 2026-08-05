/**
 * Regression tests: orphan-cleanup must not blind-claim every 'running'/'queued'
 * worker_jobs row on every sweep.
 *
 * The bug (daemon/src/core/orphan-cleanup.ts, worker_jobs branch): the sweep
 * unconditionally fails every running/queued job with no ownership or
 * liveness check at all. If a second daemon process ever attaches to the
 * same database, this claims the FIRST daemon's genuinely-live workers as
 * failed. It also stamps a fabricated cause ("daemon restarted while job was
 * active") that the code never actually observed.
 *
 * These tests seed real child processes as job "owners" (via owner_pid /
 * owner_started_at columns) so liveness is checked against real OS process
 * state, not a mock — the same mechanism production code must use.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { openDatabase, _resetDbForTesting, query, exec } from '../db.js';
import { _resetConfigForTesting, loadConfig } from '../config.js';
import { cleanupOrphanedResources, _setDepsForTesting } from '../orphan-cleanup.js';

// ── Test harness ──────────────────────────────────────────────

function setupTestEnv(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orphan-jobs-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
scheduler:
  tasks: []
`);
  _resetConfigForTesting();
  loadConfig(tmpDir);
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  return tmpDir;
}

function cleanupTestEnv(tmpDir: string): void {
  _setDepsForTesting(null);
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** All tmux sessions dead, orch state = 'active' — isolates the worker_jobs branch. */
function mockDeadSessions(): void {
  _setDepsForTesting({
    isTmuxSessionAlive: () => false,
    getOrchestratorState: () => 'active',
    killOrchestratorSession: () => false,
  });
}

/**
 * owner_pid / owner_started_at may not exist yet on the schema under test
 * (they're added by a migration as part of the fix). Add them defensively so
 * this test file compiles and runs identically before and after the fix
 * lands — duplicate-column errors (post-migration) are swallowed.
 */
function ensureOwnerColumns(): void {
  for (const stmt of [
    `ALTER TABLE worker_jobs ADD COLUMN owner_pid INTEGER`,
    `ALTER TABLE worker_jobs ADD COLUMN owner_started_at TEXT`,
  ]) {
    try {
      exec(stmt);
    } catch (err) {
      if (!String(err).includes('duplicate column name')) throw err;
    }
  }
}

function insertAgentAndJob(id: string, ownerPid: number | null): void {
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
     VALUES (?, 'worker', 'coding', 'running', ?, ?)`,
    id, ts, ts,
  );
  exec(
    `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, owner_pid, created_at, started_at)
     VALUES (?, ?, 'coding', 'test prompt', 'running', ?, ?, ?)`,
    id, id, ownerPid, ts, ts,
  );
}

/** Spawn a real child process and wait until it has actually exited. */
async function spawnAndWaitForExit(): Promise<number> {
  const proc = spawn(process.platform === 'win32' ? 'cmd' : 'true', process.platform === 'win32' ? ['/c', 'exit', '0'] : [], {
    stdio: 'ignore',
  });
  const pid = proc.pid!;
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  return pid;
}

// ── Suite ─────────────────────────────────────────────────────

describe('orphan-cleanup: worker_jobs liveness (not unconditional-claim)', { concurrency: 1 }, () => {
  let tmpDir: string;
  let liveChild: ChildProcess | null = null;

  beforeEach(() => {
    tmpDir = setupTestEnv();
    mockDeadSessions();
    ensureOwnerColumns();
    liveChild = null;
  });

  afterEach(() => {
    if (liveChild) {
      try { liveChild.kill(); } catch { /* already dead */ }
      liveChild = null;
    }
    cleanupTestEnv(tmpDir);
  });

  // ── Test A: the defect — a live owner's job must survive the sweep ───────

  it('TEST A: does not touch a running job whose owner process is still alive', async () => {
    liveChild = spawn('sleep', ['20'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => liveChild!.once('spawn', () => resolve()));
    const ownerPid = liveChild.pid!;

    insertAgentAndJob('job-live-owner', ownerPid);

    const report = cleanupOrphanedResources();

    const after = query<{ status: string; finished_at: string | null; error: string | null }>(
      `SELECT status, finished_at, error FROM worker_jobs WHERE id = ?`, 'job-live-owner',
    );
    assert.equal(after.length, 1, 'job row must still exist');
    assert.equal(
      after[0]!.status,
      'running',
      `a job whose owner process (pid ${ownerPid}) is still alive must NOT be claimed by the sweep. ` +
      `Against the current unconditional-claim code this fails because every running job is failed ` +
      `regardless of whether its owner is still live.`,
    );
    assert.equal(after[0]!.finished_at, null, 'finished_at must remain unset for a preserved job');
    assert.equal(report.jobsFailedOrphaned, 0, 'report must not count a live-owned job as claimed');
  });

  // ── Test B: anti-no-op / mutation-kill guard — genuinely dead owner MUST be claimed ──

  it('TEST B: claims a running job whose owner process has actually exited', async () => {
    const deadPid = await spawnAndWaitForExit();

    insertAgentAndJob('job-dead-owner', deadPid);

    const report = cleanupOrphanedResources();

    const after = query<{ status: string; finished_at: string | null; error: string | null }>(
      `SELECT status, finished_at, error FROM worker_jobs WHERE id = ?`, 'job-dead-owner',
    );
    assert.equal(after.length, 1, 'job row must still exist');
    assert.equal(
      after[0]!.status,
      'failed',
      `a job whose owner process (pid ${deadPid}) has exited must be claimed and marked failed — ` +
      `otherwise genuinely orphaned jobs would leak forever (the no-op failure mode).`,
    );
    assert.ok(after[0]!.finished_at, 'finished_at must be set once claimed');
    assert.equal(report.jobsFailedOrphaned, 1, 'report must count exactly one claimed job');
  });

  // ── Test C: honesty — never assert a restart that was never observed ─────

  it('TEST C: the recorded error never asserts an unobserved daemon restart', async () => {
    const deadPid = await spawnAndWaitForExit();

    insertAgentAndJob('job-dead-owner-honesty', deadPid);

    cleanupOrphanedResources();

    const after = query<{ error: string | null }>(
      `SELECT error FROM worker_jobs WHERE id = ?`, 'job-dead-owner-honesty',
    );
    assert.equal(after.length, 1);
    assert.ok(
      !after[0]!.error?.includes('daemon restarted'),
      `error must not assert a daemon restart that was never observed; got: ${after[0]!.error}`,
    );
    assert.ok(
      after[0]!.error?.includes(String(deadPid)) || after[0]!.error?.toLowerCase().includes('no longer running'),
      `error should describe what was actually observed (owner pid gone); got: ${after[0]!.error}`,
    );
  });
});
