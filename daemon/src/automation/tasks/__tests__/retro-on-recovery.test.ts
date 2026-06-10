/**
 * Tests for retro hooks on recovery-failure paths (Round 3, Fix B).
 *
 * Tasks failed by the daemon's recovery machinery (orchestrator death,
 * orchestrator restart, stale-task recovery) bypass the normal
 * PUT /api/orchestrator/tasks/:id completion path — which is where retro
 * evaluation was previously dispatched. These tests verify that each
 * recovery path now fires the (injected) evaluateTask hook.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../../core/config.js';
import { openDatabase, _resetDbForTesting, exec, query } from '../../../core/db.js';
import {
  _runForTesting as runIdleMonitor,
  _setDepsForTesting as setIdleDeps,
  _resetNudgeStateForTesting,
} from '../orchestrator-idle.js';
import {
  _runForTesting as runStaleRecovery,
  _setDepsForTesting as setStaleDeps,
} from '../orch-stale-task-recovery.js';

// ── Helpers ──────────────────────────────────────────────────

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** Insert an orchestrator task; returns the INTEGER rowid. */
function insertTask(opts: {
  extId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  assignedAt?: string | null;
}): number {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at, started_at, assigned_at)
     VALUES (?, 'orchestrator', 'Recovery test task', ?, ?, ?, ?, ?)`,
    opts.extId,
    opts.status,
    opts.createdAt ?? isoMinutesAgo(120),
    opts.updatedAt ?? new Date().toISOString(),
    opts.startedAt ?? null,
    opts.assignedAt ?? null,
  );
  const rows = query<{ id: number }>('SELECT id FROM tasks WHERE external_id = ?', opts.extId);
  return rows[0]!.id;
}

function getTask(extId: string): { status: string; error: string | null } {
  const rows = query<{ status: string; error: string | null }>(
    'SELECT status, error FROM tasks WHERE external_id = ?',
    extId,
  );
  return rows[0]!;
}

/** Common test fixture state. */
let tmpDir: string;
let evalCalls: string[];

function evalSpy(taskId: string): Promise<void> {
  evalCalls.push(taskId);
  return Promise.resolve();
}

function setup(): void {
  _resetConfigForTesting();
  _resetDbForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-recovery-'));
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    ['self_improvement:', '  enabled: true', '  retro:', '    enabled: true'].join('\n') + '\n',
  );
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  evalCalls = [];
  _resetNudgeStateForTesting();
}

function teardown(): void {
  setIdleDeps(null);
  setStaleDeps(null);
  _resetNudgeStateForTesting();
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── orchestrator-idle: zombie task cleanup ───────────────────

describe('orchestrator-idle: retro hook on zombie task cleanup', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('fires evaluateTask for each task failed by cleanupZombieTasks (orch dead)', async () => {
    insertTask({ extId: 'zombie-ext-1', status: 'in_progress' });
    insertTask({ extId: 'zombie-ext-2', status: 'assigned' });

    setIdleDeps({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
      evaluateTask: evalSpy,
    });

    await runIdleMonitor({});

    assert.equal(getTask('zombie-ext-1').status, 'failed');
    assert.equal(getTask('zombie-ext-1').error, 'orchestrator_died');
    assert.equal(getTask('zombie-ext-2').status, 'failed');
    assert.deepEqual(evalCalls.sort(), ['zombie-ext-1', 'zombie-ext-2']);
  });

  it('fires evaluateTask for tasks failed by cleanupOrphanedTasks (orch restarted)', async () => {
    // Current orchestrator instance started "now"; the task started an hour
    // ago — it belongs to the previous (dead) instance.
    const now = new Date().toISOString();
    exec(
      `INSERT INTO agents (id, type, profile, status, tmux_session, started_at, created_at, updated_at)
       VALUES ('orchestrator', 'orchestrator', 'orchestrator', 'running', 'kk-orch', ?, ?, ?)`,
      now, now, now,
    );
    insertTask({ extId: 'orphan-ext-1', status: 'in_progress', startedAt: isoMinutesAgo(60) });

    setIdleDeps({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
      evaluateTask: evalSpy,
    });

    await runIdleMonitor({});

    assert.equal(getTask('orphan-ext-1').status, 'failed');
    assert.equal(getTask('orphan-ext-1').error, 'orchestrator_restarted');
    // Exactly one evaluation — the zombie sweep must not double-fire on the
    // already-failed task.
    assert.deepEqual(evalCalls, ['orphan-ext-1']);
  });
});

// ── orch-stale-task-recovery ─────────────────────────────────

describe('orch-stale-task-recovery: retro hook on stale recovery', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('fires evaluateTask when a stale task is recovered (orch dead, no live workers)', async () => {
    insertTask({ extId: 'stale-ext-1', status: 'in_progress', updatedAt: isoMinutesAgo(120) });

    setStaleDeps({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      getJobStatus: () => null,
      evaluateTask: evalSpy,
    });

    await runStaleRecovery({});

    assert.equal(getTask('stale-ext-1').status, 'failed');
    assert.equal(getTask('stale-ext-1').error, 'stale_task_recovery');
    assert.deepEqual(evalCalls, ['stale-ext-1']);
  });

  it('does not fire evaluateTask when the orchestrator is alive (warn-only path)', async () => {
    insertTask({ extId: 'stale-ext-2', status: 'in_progress', updatedAt: isoMinutesAgo(120) });

    setStaleDeps({
      isOrchestratorAlive: () => true,
      injectMessage: () => true,
      getJobStatus: () => null,
      evaluateTask: evalSpy,
    });

    await runStaleRecovery({});

    assert.equal(getTask('stale-ext-2').status, 'in_progress');
    assert.deepEqual(evalCalls, []);
  });

  it('does not fire evaluateTask when the stale task still has a live worker', async () => {
    const rowid = insertTask({
      extId: 'stale-ext-3',
      status: 'in_progress',
      updatedAt: isoMinutesAgo(120),
    });
    exec(
      `INSERT INTO task_workers (task_id, worker_id, role, assigned_at) VALUES (?, 'w-live-1', 'coding', ?)`,
      rowid, new Date().toISOString(),
    );

    setStaleDeps({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      getJobStatus: () => ({ status: 'running' }),
      evaluateTask: evalSpy,
    });

    await runStaleRecovery({});

    assert.equal(getTask('stale-ext-3').status, 'in_progress');
    assert.deepEqual(evalCalls, []);
  });
});
