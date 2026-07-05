/**
 * Regression tests: orchestrator-idle reads from unified tasks table (#581).
 *
 * PR #289 migrated the escalate path and zombie/orphan cleanup queries.
 * This file verifies the 9 remaining read queries in orchestrator-idle.ts
 * (checkTaskTimeouts + run()) now read from `tasks` with kind='orchestrator',
 * and that a kind='todo' row is never counted as orchestrator work.
 *
 * Refs: #581, #94, #289, #292
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, _resetDbForTesting, insert, update, exec } from '../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import {
  _resetNudgeStateForTesting,
  _setNudgeStateForTesting,
  _getNudgeStateForTesting,
  _runForTesting,
  _setDepsForTesting,
  _resetPendingActiveNudgeStateForTesting,
} from '../automation/tasks/orchestrator-idle.js';

// ── Test harness ──────────────────────────────────────────────

function setupTestEnv(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orch-idle-unified-'));
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

  // Seed orchestrator agent row — required for several code paths
  insert('agents', {
    id: 'orchestrator',
    type: 'orchestrator',
    status: 'running',
    started_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return tmpDir;
}

function cleanupTestEnv(tmpDir: string): void {
  _setDepsForTesting(null);
  _resetNudgeStateForTesting();
  _resetPendingActiveNudgeStateForTesting();
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Suite ─────────────────────────────────────────────────────

describe('orchestrator-idle reads unified tasks table', { concurrency: 1 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  // ── Test 1: pending detection (lines 545 + 593 + 704 paths) ──────────────

  it('pending detection — respawns dead orchestrator for task in tasks table with kind=orchestrator', async () => {
    let spawned = false;
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { spawned = true; return 'orch-respawn-session'; },
      cleanupSessionDirs: () => 0,
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('pending-unified-001', 'orchestrator', 'Pending unified task', 'do it', 'pending', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.ok(spawned, 'should have respawned orchestrator when a pending task exists in the unified tasks table');
  });

  it('pending detection — alive orchestrator receives pending-task notification for task in tasks table', async () => {
    // This test verifies that when a pending orchestrator task exists in the unified tasks table,
    // the alive idle-monitor injects a pending-task notification (not a shutdown prompt) to the
    // orchestrator. Both Check 0 (Claude actively processing) and Check 3 (idle timeout) paths
    // read from tasks WHERE kind='orchestrator'. We assert the orchestrator is not nudged to shut
    // down, which is correct in both code paths.
    const injectCalls: Array<{ target: string; text: string }> = [];
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should not kill'); },
      injectMessage: (target: string, text: string) => { injectCalls.push({ target, text }); return true; },
      cleanupSessionDirs: () => 0,
      // Must mock isClaudeProcessRunning to false so Check 0 does not intercept and
      // return early before reaching Check 3 (the pending-task wake path with task title).
      // Without this, a live tmux environment may cause Check 0 to fire and inject a
      // different (generic queue-reminder) message that does NOT include the task title.
      isClaudeProcessRunning: () => false,
    });

    // Make last_activity old enough to trigger the idle-timeout path
    update('agents', 'orchestrator', {
      last_activity: new Date(Date.now() - 15 * 60_000).toISOString(),
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('pending-unified-002', 'orchestrator', 'Wake nudge task', 'details', 'pending', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    // Neither Check 0 nor Check 3 should send a shutdown prompt to the orchestrator
    // (Check 0 sends a queue reminder; Check 3 sends a wake message with the title)
    const shutdownToOrch = injectCalls.filter(c => c.target === 'orchestrator' && c.text.includes('Shutdown requested'));
    assert.equal(shutdownToOrch.length, 0, 'should NOT inject shutdown prompt to orchestrator when pending tasks exist in tasks table');
    // At least one notification went to 'orchestrator' mentioning pending work
    const orchNotifications = injectCalls.filter(c => c.target === 'orchestrator');
    assert.ok(orchNotifications.length > 0, 'should have injected a pending-work notification to orchestrator');
  });

  // ── Test 2: awaiting-approval guards (lines 475, 558, 624) ───────────────

  it('awaiting-approval guard — defers idle shutdown when tasks table has kind=orchestrator awaiting_approval', async () => {
    const injectCalls: Array<{ target: string; text: string }> = [];
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should not kill'); },
      injectMessage: (target: string, text: string) => { injectCalls.push({ target, text }); return true; },
      cleanupSessionDirs: () => 0,
    });

    update('agents', 'orchestrator', {
      last_activity: new Date(Date.now() - 15 * 60_000).toISOString(),
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, created_at, updated_at)
       VALUES ('awaiting-unified-001', 'orchestrator', 'Awaiting approval task', 'awaiting_approval', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    const state = _getNudgeStateForTesting();
    assert.equal(state.nudgedAt, null, 'should NOT set shutdown nudge when tasks table has awaiting_approval rows');
    const shutdownInjects = injectCalls.filter(c => c.target === 'orchestrator' && c.text.includes('Shutdown requested'));
    assert.equal(shutdownInjects.length, 0, 'should NOT inject shutdown prompt while tasks table has awaiting_approval rows');
  });

  it('awaiting-approval guard — respawns dead orchestrator for awaiting_approval task in tasks table', async () => {
    let spawned = false;
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { spawned = true; return 'orch-session-awaiting'; },
      cleanupSessionDirs: () => 0,
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('awaiting-unified-002', 'orchestrator', 'Plan awaiting approval', 'details', 'awaiting_approval', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.ok(spawned, 'should have respawned orchestrator for awaiting_approval task in tasks table');
  });

  it('grace-period guard — extends grace period when tasks table has awaiting_approval row', async () => {
    let killed = false;
    _setNudgeStateForTesting(Date.now() - 90_000, 'idle timeout');
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killed = true; return true; },
      injectMessage: () => true,
      cleanupSessionDirs: () => 0,
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, created_at, updated_at)
       VALUES ('awaiting-unified-003', 'orchestrator', 'Grace guard task', 'awaiting_approval', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.equal(killed, false, 'should NOT force-kill when tasks table has awaiting_approval rows during grace period');
  });

  // ── Test 3: plan SLA (line 411) ──────────────────────────────────────────

  it('plan SLA — nudges comms when tasks table has overdue plan submission', async () => {
    const injectCalls: Array<{ target: string; text: string }> = [];
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should not kill'); },
      injectMessage: (target: string, text: string) => { injectCalls.push({ target, text }); return true; },
      cleanupSessionDirs: () => 0,
    });

    // Keep last_activity fresh so idle timeout does not fire before SLA check runs
    update('agents', 'orchestrator', {
      last_activity: new Date().toISOString(),
    });

    // Insert a task with plan submitted 40 min ago (past the default 30-min SLA)
    const oldPlanAt = new Date(Date.now() - 40 * 60_000).toISOString();
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, plan_status, plan_submitted_at, priority, created_at, updated_at)
       VALUES ('sla-unified-001', 'orchestrator', 'Plan SLA task', 'awaiting_approval', 'submitted', ?, 'low', ?, ?)`,
      oldPlanAt, oldPlanAt, oldPlanAt,
    );

    await _runForTesting({});

    const commsNudges = injectCalls.filter(c => c.target === 'comms' && c.text.includes('plan review needed'));
    assert.ok(commsNudges.length > 0, 'should have nudged comms about overdue plan submission in tasks table');
    assert.ok(commsNudges[0]!.text.includes('Plan SLA task'), 'nudge should include the task title');
  });

  // ── Test 4: stale-task warnings (lines 344, 361) ─────────────────────────

  it('stale-task warnings — checkTaskTimeouts does not throw with aged pending/assigned/in_progress in tasks table', async () => {
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should not kill'); },
      injectMessage: () => true,
      cleanupSessionDirs: () => 0,
    });

    // Keep last_activity fresh so idle timeout does not fire
    update('agents', 'orchestrator', {
      last_activity: new Date().toISOString(),
    });

    // Stale pending task (created 10 min ago — past 5-min PENDING_TIMEOUT_MS)
    const staleTime = new Date(Date.now() - 10 * 60_000).toISOString();
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, created_at, updated_at)
       VALUES ('stale-pending-001', 'orchestrator', 'Stale pending task', 'pending', 'low', ?, ?)`,
      staleTime, staleTime,
    );

    // Stale assigned task (created 10 min ago)
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, assigned_to, priority, created_at, updated_at)
       VALUES ('stale-assigned-001', 'orchestrator', 'Stale assigned task', 'assigned', 'orchestrator', 'low', ?, ?)`,
      staleTime, staleTime,
    );

    // Stale in_progress task (updated 15 min ago — past 10-min STALE_WORK_NOTES_MS)
    const staleActiveTime = new Date(Date.now() - 15 * 60_000).toISOString();
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, created_at, updated_at)
       VALUES ('stale-active-001', 'orchestrator', 'Stale in-progress task', 'in_progress', 'low', ?, ?)`,
      staleActiveTime, staleActiveTime,
    );

    // checkTaskTimeouts must not throw — verifies read path works with tasks table
    await assert.doesNotReject(_runForTesting({}), 'checkTaskTimeouts must not throw with aged tasks in the unified tasks table');
  });

  // ── Test 5: kind filter isolation ────────────────────────────────────────

  it('kind filter isolation — kind=todo pending task does NOT trigger orchestrator respawn', async () => {
    let spawned = false;
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { spawned = true; return 'should-not-spawn'; },
      cleanupSessionDirs: () => 0,
    });

    // Insert a todo task — must NOT be counted by orchestrator idle monitor
    exec(
      `INSERT INTO tasks (kind, title, status, priority, created_at, updated_at)
       VALUES ('todo', 'Buy milk', 'pending', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.equal(spawned, false, 'a kind=todo pending task must NOT trigger orchestrator respawn — kind filter must isolate orchestrator reads');
  });

  it('kind filter isolation — kind=todo awaiting_approval task does NOT trigger dead-orchestrator respawn', async () => {
    // When the orchestrator is dead, the idle monitor checks tasks WHERE kind='orchestrator' AND
    // status='awaiting_approval'. A kind='todo' row must be invisible to this check — if it were
    // visible, it would spuriously respawn the orchestrator.
    let spawned = false;
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { spawned = true; return 'should-not-spawn'; },
      cleanupSessionDirs: () => 0,
    });

    // Insert a todo-kind awaiting_approval row — must NOT trigger orchestrator respawn
    exec(
      `INSERT INTO tasks (kind, title, status, priority, created_at, updated_at)
       VALUES ('todo', 'Todo awaiting approval', 'awaiting_approval', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.equal(spawned, false, 'a kind=todo awaiting_approval task must NOT trigger orchestrator respawn — kind filter must isolate awaiting_approval reads');
  });
});
