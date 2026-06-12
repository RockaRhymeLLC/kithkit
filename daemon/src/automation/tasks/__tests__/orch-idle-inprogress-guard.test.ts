/**
 * Regression test: orchestrator must NOT be killed when a task is in_progress/assigned.
 *
 * Bug: the idle-monitor's final force-kill gate (Check 3) only queried for
 * status='pending' before sending the shutdown nudge / force-killing. Tasks with
 * status IN ('in_progress','assigned') were invisible to the guard, so the
 * orchestrator would be reaped mid-task — orphaning work it was actively handling.
 *
 * Fix: added Check 3b (immediately before the shutdown path) that queries for
 * in_progress/assigned tasks and injects a resume nudge instead of shutting down.
 *
 * THIS TEST DRIVES THE REAL GATE via _runForTesting() — the production entry
 * point — with all external I/O mocked through _setDepsForTesting(). Per the #439
 * bar, reverting the Check 3b guard must turn this test RED.
 *
 * CI placement: daemon/src/automation/tasks/__tests__/ compiles to
 * daemon/dist/automation/tasks/__tests__/, which is found by the CI test runner:
 *   npm test → node --test $(find dist -name '*.test.js')
 * (see .github/workflows/ci.yml, daemon package.json test script)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../../core/config.js';
import { openDatabase, _resetDbForTesting, exec } from '../../../core/db.js';
import {
  _runForTesting as runIdleMonitor,
  _setDepsForTesting as setIdleDeps,
  _resetNudgeStateForTesting,
  _setJustSpawnedAtForTesting,
} from '../orchestrator-idle.js';

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

let tmpDir: string;

function setup(): void {
  _resetConfigForTesting();
  _resetDbForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orchguard-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), 'agent:\n  name: test\n');
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  _resetNudgeStateForTesting();
  _setJustSpawnedAtForTesting(null); // ensure fast-retry window is closed
}

function teardown(): void {
  setIdleDeps(null);
  _resetNudgeStateForTesting();
  _setJustSpawnedAtForTesting(null);
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Insert a running orchestrator agent with last_activity in the past. */
function insertOrchAgent(lastActivityMinutesAgo: number): void {
  const lastActivity = isoMinutesAgo(lastActivityMinutesAgo);
  exec(
    `INSERT INTO agents (id, type, profile, status, tmux_session, last_activity, started_at, created_at, updated_at)
     VALUES ('orchestrator', 'orchestrator', 'orchestrator', 'running', 'kk-orch', ?, ?, ?, ?)`,
    lastActivity,
    isoMinutesAgo(60),
    isoMinutesAgo(60),
    lastActivity,
  );
}

/** Insert an orchestrator task with the given status. Returns external_id. */
function insertOrchTask(extId: string, status: string): void {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Test task', ?, ?, ?)`,
    extId,
    status,
    isoMinutesAgo(30),
    isoMinutesAgo(11),
  );
}

describe('orchestrator-idle: in_progress/assigned guard (Check 3b regression)', () => {
  beforeEach(setup);
  afterEach(teardown);

  // ── PRIMARY GUARD TEST ───────────────────────────────────────

  it('does NOT kill the orchestrator when a task is in_progress — injects a resume nudge instead', async () => {
    // State: orch alive, Claude NOT running (no tmux in test), 11 min idle (> 10 min timeout),
    // no active worker_jobs, no pending tasks — only an in_progress task.
    insertOrchAgent(11);
    insertOrchTask('task-inprog-1', 'in_progress');

    let killCalled = false;
    const injectedMessages: Array<{ target: string; text: string }> = [];

    setIdleDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      injectMessage: (target, text) => { injectedMessages.push({ target, text }); return true; },
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
      evaluateTask: () => Promise.resolve(),
      isClaudeProcessRunning: () => false, // Claude NOT running — must pass Check 0
    });

    await runIdleMonitor({ idle_timeout_minutes: 10 });

    assert.equal(killCalled, false,
      'killOrchestratorSession must NOT be called when an in_progress task exists');

    const resumeNudge = injectedMessages.find(
      m => m.target === 'orchestrator' && m.text.includes('in-progress'),
    );
    assert.ok(resumeNudge,
      'should inject a resume nudge to the orchestrator when in_progress task exists');
  });

  it('does NOT kill the orchestrator when a task is assigned — injects a resume nudge instead', async () => {
    insertOrchAgent(11);
    insertOrchTask('task-assigned-1', 'assigned');

    let killCalled = false;
    const injectedMessages: Array<{ target: string; text: string }> = [];

    setIdleDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      injectMessage: (target, text) => { injectedMessages.push({ target, text }); return true; },
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
      evaluateTask: () => Promise.resolve(),
      isClaudeProcessRunning: () => false,
    });

    await runIdleMonitor({ idle_timeout_minutes: 10 });

    assert.equal(killCalled, false,
      'killOrchestratorSession must NOT be called when an assigned task exists');

    const resumeNudge = injectedMessages.find(
      m => m.target === 'orchestrator' && m.text.includes('in-progress'),
    );
    assert.ok(resumeNudge,
      'should inject a resume nudge to the orchestrator when assigned task exists');
  });

  // ── NON-REGRESSION: legitimate reap must still fire ─────────

  it('DOES send a shutdown nudge when there are no in_progress/assigned/pending tasks (legitimate reap)', async () => {
    // Genuinely idle — no work anywhere. The guard must not block the reap.
    insertOrchAgent(11);
    // No tasks inserted.

    const injectedMessages: Array<{ target: string; text: string }> = [];

    setIdleDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => true,
      injectMessage: (target, text) => { injectedMessages.push({ target, text }); return true; },
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
      evaluateTask: () => Promise.resolve(),
      isClaudeProcessRunning: () => false,
    });

    await runIdleMonitor({ idle_timeout_minutes: 10 });

    const shutdownNudge = injectedMessages.find(
      m => m.target === 'orchestrator' && m.text.includes('Shutdown requested'),
    );
    assert.ok(shutdownNudge,
      'should inject shutdown nudge when there is genuinely no live work');
  });
});
