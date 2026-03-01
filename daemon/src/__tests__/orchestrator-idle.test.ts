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

describe('Orchestrator idle: liveness check', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv(tmpDir);
  });

  it('does nothing when orchestrator is not alive and no nudge pending', async () => {
    _setDepsForTesting({
      isOrchestratorAlive: () => false,
      killOrchestratorSession: () => { throw new Error('should not kill'); },
      injectMessage: () => { throw new Error('should not inject'); },
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
    });

    // Set last_activity to 15 minutes ago (past 10 min default)
    update('agents', 'orchestrator', {
      last_activity: new Date(Date.now() - 15 * 60_000).toISOString(),
    });

    // Insert a pending orchestrator task
    exec(
      `INSERT INTO orchestrator_tasks (id, title, description, status, priority, created_at, updated_at)
       VALUES ('test-task-idle-1', 'Fix the login bug', 'description', 'pending', 0, ?, ?)`,
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
