/**
 * Unit tests for orchestrator-idle task:
 * - Nudge ordering: nudge check before alive check prevents missed graceful exits
 * - Graceful exit logging after nudge
 * - Liveness check: Claude process running prevents idle kill
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, closeDatabase, _resetDbForTesting, insert, update, query, exec } from '../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import {
  _resetNudgeStateForTesting,
  _setNudgeStateForTesting,
  _getNudgeStateForTesting,
  _runForTesting,
  _setDepsForTesting,
  _resetPendingActiveNudgeStateForTesting,
} from '../automation/tasks/orchestrator-idle.js';

/** Set up a temp project dir with minimal config and a real DB. */
function setupTestEnv(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orch-idle-'));
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

  // Seed an orchestrator agent row
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

describe('Orchestrator idle: nudge ordering', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  it('detects graceful exit when orchestrator dies after nudge', async () => {
    // Simulate: nudge was sent, orchestrator has since exited
    _setNudgeStateForTesting(Date.now() - 10_000, 'idle timeout');
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => { throw new Error('should not be called'); },
      injectMessage: () => { throw new Error('should not be called'); },
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    // Nudge state should be cleared after graceful exit detected
    const state = _getNudgeStateForTesting();
    assert.equal(state.nudgedAt, null, 'nudgedAt should be cleared');
    assert.equal(state.reason, null, 'reason should be cleared');
  });

  it('force-kills after grace period expires', async () => {
    let killed = false;
    // Nudge was sent 90 seconds ago (past 60s grace period)
    _setNudgeStateForTesting(Date.now() - 90_000, 'idle timeout');
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killed = true; return true; },
      injectMessage: () => true,
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    assert.equal(killed, true, 'should have force-killed after grace period');
    const state = _getNudgeStateForTesting();
    assert.equal(state.nudgedAt, null, 'nudgedAt should be cleared after force-kill');
  });

  it('waits during grace period', async () => {
    // Nudge was sent 10 seconds ago (within 60s grace period)
    _setNudgeStateForTesting(Date.now() - 10_000, 'idle timeout');
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should not kill during grace'); },
      injectMessage: () => { throw new Error('should not inject during grace'); },
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    // Nudge state should remain — still waiting
    const state = _getNudgeStateForTesting();
    assert.notEqual(state.nudgedAt, null, 'nudge state should persist during grace period');
  });
});

describe('Orchestrator idle: graceful exit logging', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  it('logs session_end activity on graceful exit', async () => {
    _setNudgeStateForTesting(Date.now() - 5_000, 'context exhaustion (70%)');
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => { throw new Error('no kill on graceful exit'); },
      injectMessage: () => { throw new Error('no inject on graceful exit'); },
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    // Check activity log for session_end entry
    const logs = query<{ event_type: string; details: string }>(
      "SELECT event_type, details FROM agent_activity_log WHERE agent_id = 'orchestrator' AND event_type = 'session_end'",
    );
    assert.ok(logs.length > 0, 'should have logged session_end');
    assert.ok(
      logs[0]!.details.includes('context exhaustion'),
      `details should mention reason: ${logs[0]!.details}`,
    );
  });
});

describe('Orchestrator idle: zombie task cleanup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  it('marks in_progress tasks as failed when orchestrator dies after nudge', async () => {
    // Insert an in_progress task into the unified tasks table
    const taskExtId = 'zombie-ext-id-0001-0001';
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, created_at, updated_at)
       VALUES (?, 'orchestrator', 'In-progress task', 'in_progress', 'low', ?, ?)`,
      taskExtId, new Date().toISOString(), new Date().toISOString(),
    );

    // Simulate: nudge was sent, orchestrator has since exited
    _setNudgeStateForTesting(Date.now() - 10_000, 'idle timeout');
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => { throw new Error('should not be called'); },
      injectMessage: () => { throw new Error('should not be called'); },
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    // Task should now be failed in the unified tasks table
    const tasks = query<{ external_id: string; status: string; error: string }>(
      `SELECT external_id, status, error FROM tasks WHERE external_id = ? AND kind = 'orchestrator'`,
      taskExtId,
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.status, 'failed', 'zombie task should be marked failed');
    assert.equal(tasks[0]!.error, 'orchestrator_died', 'error should indicate orchestrator death');
  });

  it('marks assigned tasks as failed when orchestrator is dead with no nudge', async () => {
    // Insert an assigned task into the unified tasks table
    const taskExtId = 'zombie-ext-id-0002-0001';
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, assigned_to, priority, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Assigned task', 'assigned', 'orchestrator', 'low', ?, ?)`,
      taskExtId, new Date().toISOString(), new Date().toISOString(),
    );

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    const tasks = query<{ external_id: string; status: string; error: string }>(
      `SELECT external_id, status, error FROM tasks WHERE external_id = ? AND kind = 'orchestrator'`,
      taskExtId,
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.status, 'failed', 'assigned zombie task should be marked failed');
    assert.equal(tasks[0]!.error, 'orchestrator_died');
  });

  it('marks zombie tasks as failed (activity insert skipped — TODO(PR-C): migrate orchestrator_task_activity)', async () => {
    // Activity logging to orchestrator_task_activity is skipped for tasks in the unified tasks
    // table — FK constraint prevents it. The task itself is still correctly marked failed.
    const taskExtId = 'zombie-ext-id-0003-0001';
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Another zombie', 'in_progress', 'low', ?, ?)`,
      taskExtId, new Date().toISOString(), new Date().toISOString(),
    );

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    // Verify task is marked failed in the unified tasks table
    const tasks = query<{ status: string; error: string }>(
      `SELECT status, error FROM tasks WHERE external_id = ? AND kind = 'orchestrator'`,
      taskExtId,
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.status, 'failed', 'zombie task should be marked failed');
    assert.equal(tasks[0]!.error, 'orchestrator_died');
    // Activity insert is not checked here — see TODO(PR-C) in orchestrator-idle.ts
  });

  it('marks tasks from a previous orchestrator as failed when new orchestrator is running', async () => {
    // Insert an in_progress task into the unified tasks table with started_at BEFORE
    // the orchestrator's started_at (simulating a task from a previous orchestrator instance)
    const taskExtId = 'orphan-ext-id-0001-0001';
    const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, started_at, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Orphaned task', 'in_progress', 'low', ?, ?, ?)`,
      taskExtId, oldTime, oldTime, oldTime,
    );

    // Orchestrator is alive (new instance)
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => false,
      injectMessage: () => true,
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    const tasks = query<{ external_id: string; status: string; error: string }>(
      `SELECT external_id, status, error FROM tasks WHERE external_id = ? AND kind = 'orchestrator'`,
      taskExtId,
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.status, 'failed', 'orphaned task should be marked failed');
    assert.equal(tasks[0]!.error, 'orchestrator_restarted');
  });

  it('does not mark tasks from the current orchestrator as orphaned', async () => {
    // Insert an in_progress task with started_at AFTER the orchestrator's started_at
    const recentTime = new Date(Date.now() + 1000).toISOString();
    exec(
      `INSERT INTO orchestrator_tasks (id, title, description, status, priority, started_at, created_at, updated_at)
       VALUES ('current-task-1', 'Current task', null, 'in_progress', 0, ?, ?, ?)`,
      recentTime, recentTime, recentTime,
    );

    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => false,
      injectMessage: () => true,
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    const tasks = query<{ id: string; status: string }>(
      `SELECT id, status FROM orchestrator_tasks WHERE id = 'current-task-1'`,
    );
    assert.equal(tasks[0]!.status, 'in_progress', 'current task should NOT be marked as orphaned');
  });

  it('does not touch completed or failed tasks during zombie cleanup', async () => {
    // Insert a completed task — should remain completed
    exec(
      `INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at)
       VALUES ('completed-task-1', 'Already done', 'completed', 0, ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    const tasks = query<{ status: string }>(
      `SELECT status FROM orchestrator_tasks WHERE id = 'completed-task-1'`,
    );
    assert.equal(tasks[0]!.status, 'completed', 'completed task should not be touched by zombie cleanup');
  });
});

describe('Orchestrator idle: liveness check', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  it('does nothing when orchestrator is not alive, no nudge pending, and no pending tasks', async () => {
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => { throw new Error('should not kill'); },
      injectMessage: () => { throw new Error('should not inject'); },
      spawnOrchestratorSession: () => { throw new Error('should not spawn — no pending tasks'); },
      cleanupSessionDirs: () => 0,
    });

    // Should complete without error
    await _runForTesting({});
    const state = _getNudgeStateForTesting();
    assert.equal(state.nudgedAt, null);
  });

  it('skips idle check when active workers exist', async () => {
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should not kill with active workers'); },
      injectMessage: () => { throw new Error('should not nudge with active workers'); },
      cleanupSessionDirs: () => 0,
    });

    // Add a running worker job
    insert('worker_jobs', {
      id: 'job-test-1',
      agent_id: 'orchestrator',
      profile: 'research',
      status: 'running',
      prompt: 'test task',
      created_at: new Date().toISOString(),
    });

    // Make last_activity old enough to trigger idle timeout
    update('agents', 'orchestrator', {
      last_activity: new Date(Date.now() - 20 * 60_000).toISOString(),
    });

    await _runForTesting({});
    const state = _getNudgeStateForTesting();
    assert.equal(state.nudgedAt, null, 'should not nudge when workers are active');
  });

  it('sends idle nudge when no workers and idle timeout exceeded', async () => {
    let injectedText = '';
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should nudge, not kill'); },
      injectMessage: (_target: string, text: string) => { injectedText = text; return true; },
      cleanupSessionDirs: () => 0,
      // Must mock isClaudeProcessRunning to false so Check 0 does not intercept.
      // Without this, the real function may return true in a live tmux environment,
      // causing an early return before the idle-shutdown nudge path is reached.
      isClaudeProcessRunning: () => false,
    });

    // Set last_activity to 15 minutes ago (past 10 min default)
    update('agents', 'orchestrator', {
      last_activity: new Date(Date.now() - 15 * 60_000).toISOString(),
    });

    await _runForTesting({});

    const state = _getNudgeStateForTesting();
    assert.notEqual(state.nudgedAt, null, 'should have set nudge state');
    assert.ok(injectedText.includes('Shutdown requested'), 'should inject shutdown prompt');
  });

  it('wakes orchestrator with task notification instead of shutdown when pending tasks exist', async () => {
    let injectedText = '';
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should not kill'); },
      injectMessage: (_target: string, text: string) => { injectedText = text; return true; },
      cleanupSessionDirs: () => 0,
      // Must mock isClaudeProcessRunning to false so Check 0 does not intercept.
      // Without this, the real function may return true in a live tmux environment,
      // causing an early return (the pending-tasks pending-nudge in the early-return
      // block does NOT include the task title; only Check 3 does).
      isClaudeProcessRunning: () => false,
    });

    // Set last_activity to 15 minutes ago (past 10 min default)
    update('agents', 'orchestrator', {
      last_activity: new Date(Date.now() - 15 * 60_000).toISOString(),
    });

    // Insert a pending orchestrator task into the unified tasks table
    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('test-task-idle-1', 'orchestrator', 'Fix the login bug', 'description', 'pending', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    const state = _getNudgeStateForTesting();
    assert.equal(state.nudgedAt, null, 'should NOT set shutdown nudge state');
    assert.ok(injectedText.includes('pending task'), 'should inject task notification not shutdown');
    assert.ok(injectedText.includes('Fix the login bug'), 'should include task title');
    assert.ok(!injectedText.includes('Shutdown requested'), 'should NOT inject shutdown prompt');
  });
});

describe('Orchestrator idle: awaiting_approval guard (#106)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  it('skips idle shutdown when tasks are awaiting plan approval', async () => {
    const injectCalls: Array<{ target: string; text: string }> = [];
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { throw new Error('should not kill'); },
      injectMessage: (target: string, text: string) => { injectCalls.push({ target, text }); return true; },
      cleanupSessionDirs: () => 0,
    });

    // Make last_activity old enough to normally trigger idle shutdown
    update('agents', 'orchestrator', {
      last_activity: new Date(Date.now() - 15 * 60_000).toISOString(),
    });

    // Insert a task in awaiting_approval state into the unified tasks table
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, created_at, updated_at)
       VALUES ('approval-guard-1', 'orchestrator', 'Plan awaiting approval', 'awaiting_approval', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    // Must not have sent a shutdown nudge to the orchestrator
    const state = _getNudgeStateForTesting();
    assert.equal(state.nudgedAt, null, 'should NOT set shutdown nudge when tasks are awaiting approval');
    const shutdownInjects = injectCalls.filter(c => c.target === 'orchestrator' && c.text.includes('Shutdown requested'));
    assert.equal(shutdownInjects.length, 0, 'should NOT inject shutdown prompt while tasks awaiting approval');
  });

  it('extends grace period when active workers are detected during expiry', async () => {
    let killed = false;
    // Nudge was sent 90 seconds ago — past the 60s grace period
    _setNudgeStateForTesting(Date.now() - 90_000, 'idle timeout');
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killed = true; return true; },
      injectMessage: () => true,
      cleanupSessionDirs: () => 0,
    });

    // Add a running worker job
    insert('worker_jobs', {
      id: 'grace-worker-1',
      agent_id: 'orchestrator',
      profile: 'coding',
      status: 'running',
      prompt: 'active work',
      created_at: new Date().toISOString(),
    });

    await _runForTesting({});

    assert.equal(killed, false, 'should NOT force-kill when active workers detected during grace period');
    const state = _getNudgeStateForTesting();
    assert.notEqual(state.nudgedAt, null, 'nudge state should be extended, not cleared');
    assert.ok(state.nudgedAt! > Date.now() - 5_000, 'grace period clock should be reset to now');
  });

  it('extends grace period when awaiting_approval tasks exist during expiry', async () => {
    let killed = false;
    // Nudge was sent 90 seconds ago — past the 60s grace period
    _setNudgeStateForTesting(Date.now() - 90_000, 'idle timeout');
    _setDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killed = true; return true; },
      injectMessage: () => true,
      cleanupSessionDirs: () => 0,
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, created_at, updated_at)
       VALUES ('grace-approval-1', 'orchestrator', 'Grace approval task', 'awaiting_approval', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.equal(killed, false, 'should NOT force-kill when awaiting_approval tasks during grace period');
    const state = _getNudgeStateForTesting();
    assert.notEqual(state.nudgedAt, null, 'grace period should be extended');
  });

  it('respawns orchestrator when dead and tasks are awaiting plan approval', async () => {
    let spawned = false;
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { spawned = true; return 'orch1'; },
      cleanupSessionDirs: () => 0,
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('awaiting-respawn-1', 'orchestrator', 'Plan pending approval', 'details', 'awaiting_approval', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.ok(spawned, 'should have respawned orchestrator for awaiting-approval tasks');

    const agents = query<{ status: string }>(
      "SELECT status FROM agents WHERE id = 'orchestrator'",
    );
    assert.equal(agents[0]!.status, 'running', 'agent status should be running after respawn');
  });

  it('does not respawn when dead and only awaiting_approval tasks exist if pending tasks also present', async () => {
    // When both pending and awaiting_approval exist, only one respawn should happen (for pending)
    let spawnCount = 0;
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { spawnCount++; return 'orch1'; },
      cleanupSessionDirs: () => 0,
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('both-pending-1', 'orchestrator', 'Pending task', 'do it', 'pending', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );
    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('both-awaiting-1', 'orchestrator', 'Approval task', 'waiting', 'awaiting_approval', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.equal(spawnCount, 1, 'should spawn exactly once even with both pending and awaiting_approval tasks');
  });
});

describe('Orchestrator idle: respawn for pending tasks when dead (#121)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  it('spawns fresh orchestrator when dead and pending tasks exist', async () => {
    let spawned = false;
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { spawned = true; return 'orch1'; },
      cleanupSessionDirs: () => 0,
    });

    // Insert a pending orchestrator task into the unified tasks table
    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('respawn-task-1', 'orchestrator', 'Deploy the widget', 'Deploy widget to prod', 'pending', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    assert.ok(spawned, 'should have spawned a fresh orchestrator');

    // Agent DB should be updated to running
    const agents = query<{ status: string }>(
      "SELECT status FROM agents WHERE id = 'orchestrator'",
    );
    assert.equal(agents[0]!.status, 'running', 'agent status should be running after respawn');
  });

  it('does not spawn when dead and no pending tasks', async () => {
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { throw new Error('should not spawn — no pending tasks'); },
      cleanupSessionDirs: () => 0,
    });

    // No pending tasks — should not spawn
    await _runForTesting({});
  });

  it('corrects stale DB status when orchestrator session is gone', async () => {
    // Set DB status to 'running' even though orch is dead (simulates failed cleanup)
    update('agents', 'orchestrator', { status: 'running' });

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { throw new Error('should not spawn — no pending tasks'); },
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    // DB status should now be corrected to 'stopped'
    const agents = query<{ status: string }>(
      "SELECT status FROM agents WHERE id = 'orchestrator'",
    );
    assert.equal(agents[0]!.status, 'stopped', 'stale running status should be corrected to stopped');
  });

  it('logs session_end activity when correcting stale DB status', async () => {
    update('agents', 'orchestrator', { status: 'running' });

    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => { throw new Error('should not spawn'); },
      cleanupSessionDirs: () => 0,
    });

    await _runForTesting({});

    const logs = query<{ event_type: string; details: string }>(
      "SELECT event_type, details FROM agent_activity_log WHERE agent_id = 'orchestrator' AND event_type = 'session_end'",
    );
    assert.ok(logs.length > 0, 'should have logged session_end for stale status correction');
    assert.ok(logs[0]!.details.includes('stale'), `details should mention stale: ${logs[0]!.details}`);
  });

  it('logs session_start activity after respawn', async () => {
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => 'orch1',
      cleanupSessionDirs: () => 0,
    });

    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, created_at, updated_at)
       VALUES ('respawn-task-2', 'orchestrator', 'Another task', 'Do something', 'pending', 'low', ?, ?)`,
      new Date().toISOString(), new Date().toISOString(),
    );

    await _runForTesting({});

    const logs = query<{ event_type: string; details: string }>(
      "SELECT event_type, details FROM agent_activity_log WHERE agent_id = 'orchestrator' AND event_type = 'session_start'",
    );
    assert.ok(logs.length > 0, 'should have logged session_start after respawn');
    assert.ok(logs[0]!.details.includes('Respawned by idle monitor'), `details: ${logs[0]!.details}`);
  });
});
