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
  _resetInProgressNudgeStateForTesting,
  _getInProgressNudgeStateForTesting,
  _IN_PROGRESS_NO_PROGRESS_BUDGET,
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
  _resetInProgressNudgeStateForTesting();
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

// ── BUDGET TEST ──────────────────────────────────────────────
//
// A frozen orchestrator (in_progress task whose updated_at never advances)
// must NOT be reaped for the first N ticks (within grace budget), but MUST
// be reaped on tick N+1 (budget exhausted).
//
// Discriminator / mutation-kill proof:
//   GREEN with the bounded-nudge implementation (counter-based budget).
//   RED  when Check 3b is reverted to unconditionally reset last_activity
//        (the old behaviour) — the orch is then immortal because the idle
//        clock is reset every tick regardless of progress, so the reap
//        path is never reached and killOrchestratorSession is never called.

describe('orchestrator-idle: Check 3b bounded-nudge budget (mutation-kill proof)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('pins the in-progress no-progress budget at 3 ticks (regression guard)', () => {
    assert.equal(_IN_PROGRESS_NO_PROGRESS_BUDGET, 3, 'in-progress no-progress budget must stay pinned at 3 ticks');
  });

  it(`frozen orch is NOT reaped for first N (${_IN_PROGRESS_NO_PROGRESS_BUDGET}) ticks, IS reaped on tick N+1`, async () => {
    // State: orch alive, Claude NOT running, 11 min idle (> 10 min timeout),
    // single in_progress task whose updated_at NEVER advances between ticks.
    insertOrchAgent(11);
    insertOrchTask('task-frozen-budget-1', 'in_progress');

    let killCalled = false;

    // injectMessage returns false on every call:
    //  - During ticks 1..N the resume nudge injection fails, but Check 3b
    //    still returns early (within budget) → kill NOT triggered.
    //  - On tick N+1 budget is exhausted → fall-through to the shutdown path
    //    → shutdown nudge injection also fails → direct killOrchestratorSession.
    setIdleDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      injectMessage: () => false,
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
      evaluateTask: () => Promise.resolve(),
      isClaudeProcessRunning: () => false,
    });

    // Drive N+1 ticks. last_activity is never reset (injection always fails),
    // so the idle condition remains true on every tick.
    const TICKS = _IN_PROGRESS_NO_PROGRESS_BUDGET + 1; // = 4
    for (let i = 0; i < TICKS; i++) {
      await runIdleMonitor({ idle_timeout_minutes: 10 });
    }

    assert.equal(killCalled, true,
      `killOrchestratorSession must be called after ${TICKS} ticks (budget=${_IN_PROGRESS_NO_PROGRESS_BUDGET}) of a frozen in_progress task`);

    // Verify counter state was reset after triggering reap
    const state = _getInProgressNudgeStateForTesting();
    assert.equal(state.ticks, 0, 'no-progress counter should be reset to 0 after budget is exhausted');
    assert.equal(state.updatedAt, null, 'lastInProgressUpdatedAt should be null after budget is exhausted');
  });

  it('orch is NOT reaped before budget is exhausted (guard holds for all ticks within N)', async () => {
    insertOrchAgent(11);
    insertOrchTask('task-frozen-budget-2', 'in_progress');

    let killCalled = false;
    setIdleDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      injectMessage: () => false,
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
      evaluateTask: () => Promise.resolve(),
      isClaudeProcessRunning: () => false,
    });

    // Drive exactly N ticks (one short of the budget trigger)
    const TICKS = _IN_PROGRESS_NO_PROGRESS_BUDGET;
    for (let i = 0; i < TICKS; i++) {
      await runIdleMonitor({ idle_timeout_minutes: 10 });
    }

    assert.equal(killCalled, false,
      `killOrchestratorSession must NOT be called within the first ${TICKS} ticks (budget not yet exhausted)`);
  });

  it('orch keeps alive indefinitely when task IS progressing (updated_at advances each tick)', async () => {
    insertOrchAgent(11);
    const extId = 'task-progressing-1';
    insertOrchTask(extId, 'in_progress');

    let killCalled = false;
    setIdleDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      injectMessage: () => false,
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
      evaluateTask: () => Promise.resolve(),
      isClaudeProcessRunning: () => false,
    });

    // Drive 2× the budget ticks, but advance updated_at each tick so it's always "progressing"
    const TICKS = _IN_PROGRESS_NO_PROGRESS_BUDGET * 2;
    for (let i = 0; i < TICKS; i++) {
      // Advance the task's updated_at so MAX(updated_at) changes every tick
      exec(
        `UPDATE tasks SET updated_at = ? WHERE external_id = ? AND kind = 'orchestrator'`,
        new Date(Date.now() + i * 1000).toISOString(),
        extId,
      );
      await runIdleMonitor({ idle_timeout_minutes: 10 });
    }

    assert.equal(killCalled, false,
      'kill must NOT be triggered when the task keeps advancing — only frozen orchs get reaped');
    // Counter should have been reset to 0 on every tick (always "progressing")
    const state = _getInProgressNudgeStateForTesting();
    assert.equal(state.ticks, 0, 'no-progress counter should remain 0 while task is progressing');
  });
});
