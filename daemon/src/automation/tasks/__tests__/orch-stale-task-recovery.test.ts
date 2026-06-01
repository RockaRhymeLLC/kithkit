/**
 * Tests for orch-stale-task-recovery scheduler handler.
 *
 * Covers:
 *   - Stranded in_progress task with dead orchestrator → marked failed
 *   - Stranded assigned task with dead orchestrator → marked failed
 *   - Task with live workers skipped (no false positive)
 *   - Fresh task (within threshold) not touched
 *   - completed/failed tasks not touched
 *   - Alive orchestrator → warning logged only, task NOT failed
 *   - Comms notified when recovery occurs
 *
 * FAIL-PRE-FIX / PASS-POST-FIX pattern:
 *   Without the handler registered, the scheduler silent-skips the
 *   'orch-stale-task-recovery' task (no handler, no command). With it
 *   wired into registerCoreTasks, the handler runs and recovers tasks.
 *   The direct _runForTesting() tests demonstrate pass-post-fix.
 *
 * Refs: kithkit#335, fleet tracking #123
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, _resetDbForTesting, exec, query } from '../../../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../../../core/config.js';
import { _runForTesting, _setDepsForTesting } from '../orch-stale-task-recovery.js';

// ── Test harness ──────────────────────────────────────────────

let tmpDir: string;
let taskSeq = 0;

function setupTestEnv(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-stale-recovery-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
scheduler:
  tasks: []
`);
  _resetConfigForTesting();
  loadConfig(tmpDir);
  _resetDbForTesting();
  openDatabase(tmpDir);

  // Disable FK constraints for simpler test seeding
  try {
    exec('PRAGMA foreign_keys = OFF');
  } catch {
    // best-effort
  }
}

function cleanupTestEnv(): void {
  _setDepsForTesting(null);
  _resetDbForTesting();
  _resetConfigForTesting();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Insert an orchestrator task into the unified `tasks` table.
 * Returns the external_id (UUID) and the INTEGER rowid.
 */
function seedTask(opts: {
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
  ageMs: number; // how old updated_at should be
}): { extId: string; rowid: number } {
  taskSeq++;
  const extId = `test-task-${taskSeq}-${Date.now()}`;
  const now = new Date();
  const updatedAt = new Date(now.getTime() - opts.ageMs).toISOString();
  const createdAt = new Date(now.getTime() - opts.ageMs - 1000).toISOString();

  exec(
    `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
     VALUES (?, 'orchestrator', ?, 'test description', ?, 'low', ?, ?)`,
    extId,
    `Test task ${taskSeq}`,
    opts.status,
    createdAt,
    updatedAt,
  );

  const rows = query<{ id: number; external_id: string }>(
    'SELECT id, external_id FROM tasks WHERE external_id = ?',
    extId,
  );
  const row = rows[0];
  if (!row) throw new Error(`Failed to seed task ${extId}`);
  return { extId, rowid: row.id };
}

/**
 * Get current task status from the DB.
 */
function getTaskStatus(extId: string): string | null {
  const rows = query<{ status: string }>('SELECT status FROM tasks WHERE external_id = ?', extId);
  return rows[0]?.status ?? null;
}

/**
 * Get task error field from the DB.
 */
function getTaskError(extId: string): string | null {
  const rows = query<{ error: string | null }>('SELECT error FROM tasks WHERE external_id = ?', extId);
  return rows[0]?.error ?? null;
}

// ── Config used in all tests (very short thresholds) ─────────
const STALE_CONFIG: Record<string, unknown> = {
  // 5 seconds — so tasks aged > 5s are "stale" in tests
  stale_assigned_ms: 5_000,
  stale_in_progress_ms: 5_000,
};

// ── Tests ─────────────────────────────────────────────────────

describe('orch-stale-task-recovery: dead orchestrator recovery', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('marks stale in_progress task failed when orchestrator is dead and no live workers', async () => {
    const { extId } = seedTask({ status: 'in_progress', ageMs: 10_000 }); // 10s > threshold

    const injectCalls: string[] = [];
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: (_target, text) => { injectCalls.push(text); return true; },
      getJobStatus: () => null, // no live workers
    });

    // PASS-POST-FIX: handler runs and recovers the task
    await _runForTesting(STALE_CONFIG);

    assert.strictEqual(getTaskStatus(extId), 'failed', 'stale in_progress task should be marked failed');
    assert.strictEqual(getTaskError(extId), 'stale_task_recovery', 'error field should be stale_task_recovery');
    assert.ok(injectCalls.some(m => m.includes('stale-recovery')), 'comms should be notified');
  });

  it('marks stale assigned task failed when orchestrator is dead and no live workers', async () => {
    const { extId } = seedTask({ status: 'assigned', ageMs: 10_000 });

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      getJobStatus: () => null,
    });

    await _runForTesting(STALE_CONFIG);

    assert.strictEqual(getTaskStatus(extId), 'failed');
    assert.strictEqual(getTaskError(extId), 'stale_task_recovery');
  });

  it('leaves task untouched when orchestrator is dead but task has a live worker', async () => {
    const { extId, rowid } = seedTask({ status: 'in_progress', ageMs: 10_000 });

    // Seed a worker in task_workers (rowid = tasks.id INTEGER PK)
    exec(
      `INSERT INTO task_workers (task_id, worker_id, role, assigned_at)
       VALUES (?, 'worker-live-001', 'coding', ?)`,
      rowid,
      new Date().toISOString(),
    );

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => { throw new Error('should not inject — no recovery'); },
      getJobStatus: (id) => id === 'worker-live-001' ? { status: 'running' } : null,
    });

    await _runForTesting(STALE_CONFIG);

    // Task should NOT be failed — live worker still running
    assert.strictEqual(getTaskStatus(extId), 'in_progress', 'task with live worker should be untouched');
  });

  it('leaves fresh task untouched even with dead orchestrator (within threshold)', async () => {
    // 1 second old — well within 5s threshold
    const { extId } = seedTask({ status: 'in_progress', ageMs: 1_000 });

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => { throw new Error('should not inject — fresh task not stale'); },
      getJobStatus: () => null,
    });

    await _runForTesting(STALE_CONFIG);

    assert.strictEqual(getTaskStatus(extId), 'in_progress', 'fresh task should not be touched');
  });

  it('does not touch completed or failed tasks', async () => {
    const { extId: completedId } = seedTask({ status: 'completed', ageMs: 10_000 });
    const { extId: failedId } = seedTask({ status: 'failed', ageMs: 10_000 });

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      getJobStatus: () => null,
    });

    await _runForTesting(STALE_CONFIG);

    // Statuses must be unchanged
    assert.strictEqual(getTaskStatus(completedId), 'completed');
    assert.strictEqual(getTaskStatus(failedId), 'failed');
  });

  it('does not touch pending tasks (they are not assigned/in_progress)', async () => {
    const { extId } = seedTask({ status: 'pending', ageMs: 10_000 });

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      getJobStatus: () => null,
    });

    await _runForTesting(STALE_CONFIG);

    assert.strictEqual(getTaskStatus(extId), 'pending', 'pending tasks are not in scope for recovery');
  });

  it('handles multiple stale tasks — fails all without live workers', async () => {
    const { extId: e1 } = seedTask({ status: 'in_progress', ageMs: 10_000 });
    const { extId: e2 } = seedTask({ status: 'assigned', ageMs: 10_000 });
    const { extId: e3 } = seedTask({ status: 'in_progress', ageMs: 1_000 }); // fresh

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      getJobStatus: () => null,
    });

    await _runForTesting(STALE_CONFIG);

    assert.strictEqual(getTaskStatus(e1), 'failed');
    assert.strictEqual(getTaskStatus(e2), 'failed');
    assert.strictEqual(getTaskStatus(e3), 'in_progress', 'fresh task should be untouched');
  });

  it('is idempotent — running handler twice does not error or double-fail', async () => {
    const { extId } = seedTask({ status: 'in_progress', ageMs: 10_000 });

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      getJobStatus: () => null,
    });

    // First run: recovers the task
    await _runForTesting(STALE_CONFIG);
    assert.strictEqual(getTaskStatus(extId), 'failed');

    // Second run: task already failed — should not throw, no side effects
    await _runForTesting(STALE_CONFIG);
    assert.strictEqual(getTaskStatus(extId), 'failed', 'status should remain failed after second run');
  });

  it('uses legacy orchestrator_task_workers when task_workers is absent', async () => {
    const { extId, rowid } = seedTask({ status: 'in_progress', ageMs: 10_000 });

    // Drop task_workers to simulate pre-migration instance
    try {
      exec('DROP TABLE IF EXISTS task_workers');
    } catch {
      // skip if can't drop
    }

    // Seed legacy orchestrator_task_workers by external UUID
    try {
      exec(
        `INSERT INTO orchestrator_task_workers (task_id, worker_id, role, assigned_at)
         VALUES (?, 'worker-legacy-001', 'coding', ?)`,
        extId,
        new Date().toISOString(),
      );
    } catch {
      // If orchestrator_task_workers also absent, skip this assertion
      // (the handler will just assume no workers and fail the task)
      void rowid;
      return;
    }

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => true,
      // Pretend worker is still running
      getJobStatus: (id) => id === 'worker-legacy-001' ? { status: 'running' } : null,
    });

    await _runForTesting(STALE_CONFIG);

    // With a live legacy worker, task should NOT be failed
    assert.strictEqual(getTaskStatus(extId), 'in_progress', 'task with live legacy worker should be spared');
  });
});

describe('orch-stale-task-recovery: alive orchestrator — warn only', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('does NOT fail stale tasks when orchestrator is alive', async () => {
    const { extId } = seedTask({ status: 'in_progress', ageMs: 10_000 });

    const injectCalls: string[] = [];
    _setDepsForTesting({
      isOrchestratorAlive: () => true, // orch is alive
      injectMessage: (_target, text) => { injectCalls.push(text); return true; },
      getJobStatus: () => null,
    });

    await _runForTesting(STALE_CONFIG);

    // Task should NOT be failed — orch may still complete it
    assert.strictEqual(getTaskStatus(extId), 'in_progress', 'should not fail tasks when orch is alive');
    assert.strictEqual(injectCalls.length, 0, 'should not notify comms when just warning');
  });
});

describe('orch-stale-task-recovery: empty DB edge cases', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('exits cleanly when no tasks exist', async () => {
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => { throw new Error('should not inject with empty task table'); },
      getJobStatus: () => null,
    });

    // Should not throw
    await _runForTesting(STALE_CONFIG);
  });

  it('exits cleanly when no tasks are in assigned/in_progress', async () => {
    seedTask({ status: 'completed', ageMs: 10_000 });
    seedTask({ status: 'pending', ageMs: 10_000 });

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: () => { throw new Error('should not inject'); },
      getJobStatus: () => null,
    });

    await _runForTesting(STALE_CONFIG);
  });
});
