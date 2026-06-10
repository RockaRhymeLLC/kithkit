/**
 * Regression tests: orphan-cleanup fails orphaned orchestrator tasks
 * using the internal primary key (WHERE id = ?), not the external_id column.
 *
 * The bug: the old code used `WHERE external_id = ?` to identify the row to
 * fail. SQL equality (`=`) never matches NULL, so any orchestrator task with
 * external_id IS NULL would silently survive the cleanup pass — it stayed
 * 'in_progress' forever.
 *
 * The fix: `WHERE id = ?` uses the internal integer/text primary key, which
 * is always set. Both NULL-external_id and non-NULL rows are now correctly
 * failed.
 *
 * Refs: PR #419, sn-todo-link NULL-safety class.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, _resetDbForTesting, query, exec } from '../db.js';
import { _resetConfigForTesting, loadConfig } from '../config.js';
import { cleanupOrphanedResources, _setDepsForTesting } from '../orphan-cleanup.js';

// ── Test harness ──────────────────────────────────────────────

function setupTestEnv(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orphan-cleanup-'));
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

/** Mock deps: all tmux sessions dead, orch state = 'active' (skip stale-kill path). */
function mockDeadSessions(): void {
  _setDepsForTesting({
    isTmuxSessionAlive: () => false,
    getOrchestratorState: () => 'active',
    killOrchestratorSession: () => false,
  });
}

// ── Suite ─────────────────────────────────────────────────────

describe('orphan-cleanup: fails orphaned orchestrator tasks by internal id', { concurrency: 1 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
    mockDeadSessions();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  // ── Test 1: NULL external_id — the core regression guard ─────────────────

  it('fails an in_progress orchestrator task with NULL external_id (WHERE id = ? path)', () => {
    const ts = new Date().toISOString();

    // Insert a task with external_id = NULL (no external_id column provided)
    exec(
      `INSERT INTO tasks (kind, title, status, priority, source, created_at, updated_at)
       VALUES ('orchestrator', 'Orphaned task — null external_id', 'in_progress', 'low', 'human', ?, ?)`,
      ts, ts,
    );

    // Grab the internal row id assigned by SQLite
    const seeded = query<{ id: string; external_id: string | null }>(
      `SELECT id, external_id FROM tasks WHERE title = 'Orphaned task — null external_id'`,
    );
    assert.equal(seeded.length, 1, 'precondition: task row must exist');
    assert.equal(seeded[0]!.external_id, null, 'precondition: external_id must be NULL');

    // Run cleanup
    const report = cleanupOrphanedResources();

    // The fix: cleanup must find and fail this row via its internal id
    const after = query<{ status: string; error: string }>(
      `SELECT status, error FROM tasks WHERE id = ?`, seeded[0]!.id,
    );
    assert.equal(after.length, 1, 'task row must still exist');
    assert.equal(
      after[0]!.status,
      'failed',
      'NULL-external_id orphaned task must be failed (WHERE id = ? path). ' +
      'Pre-fix (WHERE external_id = ?) this row would stay in_progress because NULL = NULL is false in SQL.',
    );
    assert.ok(
      after[0]!.error?.includes('orphaned'),
      `error field must describe orphan; got: ${after[0]!.error}`,
    );
    assert.equal(report.tasksFailedOrphaned, 1, 'report must count one failed task');
  });

  // ── Test 2: non-NULL external_id — belt-and-suspenders regression ────────

  it('also fails an in_progress orchestrator task that has a non-NULL external_id', () => {
    const ts = new Date().toISOString();
    const extId = 'deadbeef-0000-0000-0000-000000000001';

    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Orphaned task — with external_id', 'in_progress', 'low', 'human', ?, ?)`,
      extId, ts, ts,
    );

    const report = cleanupOrphanedResources();

    const after = query<{ status: string }>(
      `SELECT status FROM tasks WHERE external_id = ?`, extId,
    );
    assert.equal(after.length, 1, 'task row must still exist');
    assert.equal(after[0]!.status, 'failed', 'task with non-NULL external_id must also be failed');
    assert.equal(report.tasksFailedOrphaned, 1, 'report must count one failed task');
  });

  // ── Test 3: assigned tasks are also covered ───────────────────────────────

  it('fails an assigned orchestrator task with NULL external_id', () => {
    const ts = new Date().toISOString();

    exec(
      `INSERT INTO tasks (kind, title, status, priority, source, created_at, updated_at)
       VALUES ('orchestrator', 'Assigned orphan — null external_id', 'assigned', 'low', 'human', ?, ?)`,
      ts, ts,
    );

    const seeded = query<{ id: string }>(
      `SELECT id FROM tasks WHERE title = 'Assigned orphan — null external_id'`,
    );

    const report = cleanupOrphanedResources();

    const after = query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = ?`, seeded[0]!.id,
    );
    assert.equal(after[0]!.status, 'failed', 'assigned task with NULL external_id must be failed');
    assert.equal(report.tasksFailedOrphaned, 1);
  });
});
