/**
 * Coverage tests for the 'assigned' status gap in the wedge detector signal (i).
 *
 * BUG: A task at status='assigned' while the orchestrator is ALIVE is invisible to BOTH
 * detectors: signal(i) only checked status='in_progress', and the orphan sweep in
 * orchestrator-idle.ts binds orchStartedAt and only catches tasks predating the current
 * orch's start. Because assigned_at is stamped only when null (task-state-machine.ts:122,
 * task-queue.ts:954-955), any live-orch assignment produces assigned_at > orchStartedAt
 * BY CONSTRUCTION — the stranded task is invisible to the orphan sweep.
 *
 * FIX: Widen signal(i) predicate from status='in_progress' to
 *      status IN ('in_progress', 'assigned').
 *      GATE 2 is widened to match so the detector self-clears after firing.
 *
 * CI: daemon/src/automation/tasks/__tests__/ compiles to
 *     daemon/dist/automation/tasks/__tests__/, found by `node --test dist/**\/*.test.js`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../../core/config.js';
import { openDatabase, _resetDbForTesting, exec, query } from '../../../core/db.js';
import {
  _runForTesting as runWatchdog,
  _setWedgeDepsForTesting as setWedgeDeps,
  _resetForTesting as resetWatchdog,
  WEDGE_DEBOUNCE_THRESHOLD,
} from '../context-watchdog.js';

// ── Helpers ───────────────────────────────────────────────────

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** Prime the debounce counter, then fire the final tick. Same contract as in orch-wedge-detector.test.ts. */
async function runWatchdogUntilFires(config: Record<string, unknown>): Promise<void> {
  for (let i = 1; i < WEDGE_DEBOUNCE_THRESHOLD; i++) {
    await runWatchdog(config);
  }
  await runWatchdog(config);
}

let tmpDir: string;

function setup(): void {
  _resetConfigForTesting();
  _resetDbForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-wedge-assigned-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), 'agent:\n  name: test\n');
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  resetWatchdog();
}

function teardown(): void {
  setWedgeDeps(null);
  resetWatchdog();
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Insert a running orchestrator agent. startedMinutesAgo defaults to well before assigned_at. */
function insertOrchAgent(lastActivityMinutesAgo: number, startedMinutesAgo = 60): void {
  exec(
    `INSERT INTO agents (id, type, profile, status, tmux_session, last_activity, started_at, created_at, updated_at)
     VALUES ('orchestrator', 'orchestrator', 'orchestrator', 'running', 'orch1', ?, ?, ?, ?)`,
    isoMinutesAgo(lastActivityMinutesAgo),
    isoMinutesAgo(startedMinutesAgo),
    isoMinutesAgo(startedMinutesAgo),
    isoMinutesAgo(lastActivityMinutesAgo),
  );
}

/**
 * Insert an 'assigned' task.
 * @param assignedAtMinutesAgo - age of assigned_at (simulates when the orch claimed the task).
 * @param updatedAtMinutesAgo  - age of updated_at (what signal(i) actually reads).
 */
function insertAssignedTask(
  extId: string,
  updatedAtMinutesAgo: number,
  assignedAtMinutesAgo = updatedAtMinutesAgo,
): void {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, created_at, assigned_at, updated_at)
     VALUES (?, 'orchestrator', 'Assigned task', 'assigned', ?, ?, ?)`,
    extId,
    isoMinutesAgo(60),
    isoMinutesAgo(assignedAtMinutesAgo),
    isoMinutesAgo(updatedAtMinutesAgo),
  );
}

/** Insert an in_progress task. */
function insertInProgressTask(extId: string, updatedMinutesAgo: number): void {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
     VALUES (?, 'orchestrator', 'In-progress task', 'in_progress', ?, ?)`,
    extId,
    isoMinutesAgo(60),
    isoMinutesAgo(updatedMinutesAgo),
  );
}

// ── T1: assigned + live orch + STALE updated_at → DETECTED ────────────────────
//
// MUTATION-KILL PROOF:
// Revert: change status IN ('in_progress','assigned') back to status='in_progress'.
// Expected: killCalled stays false → test goes RED (assigned task is invisible).
// Restored: killCalled becomes true → test GREEN.

describe('orch-wedge assigned-coverage: T1 — assigned+stale triggers restart (the bug being fixed)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('DETECTS and restarts when orch is alive but assigned task updated_at is frozen [T1]', async () => {
    // Orch alive with fresh last_activity (5 min) — signal(ii) must NOT fire.
    // Assigned task frozen 20 min ago (default threshold = 15 min) — triggers signal(i).
    insertOrchAgent(5);
    // assigned_at 10 min ago (> orchStartedAt=60 min ago — simulates live-orch assignment).
    // updated_at 20 min ago (stale enough to fire).
    insertAssignedTask('task-assigned-stale-1', 20, 10);

    let killCalled = false;
    let spawnCalled = false;
    const commsMessages: string[] = [];

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => { spawnCalled = true; return 'orch-t1-respawn'; },
      captureOrchestratorPane: () => '> ',
      sendMessage: (msg) => {
        commsMessages.push(msg.body);
        return { messageId: 1, delivered: false };
      },
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'T1: killOrchestratorSession MUST be called when an assigned task is frozen — ' +
      'this is the bug being fixed; reverting to status=\'in_progress\' only makes this RED');
    assert.equal(spawnCalled, true,
      'T1: spawnOrchestratorSession MUST be called after kill');

    // GATE 2 must also reset the task to pending so the fresh orch can pick it up.
    const taskRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-assigned-stale-1'`);
    assert.equal(taskRows[0]?.status, 'pending',
      'T1: GATE 2 must reset the frozen assigned task to pending — ' +
      'without this the task is orphaned; GATE 2 must also be widened');

    const alert = commsMessages.find(b => {
      try { return JSON.parse(b)?.alert === 'orchestrator_wedge_restart'; } catch { return false; }
    });
    assert.ok(alert, 'T1: comms must receive orchestrator_wedge_restart alert');
  });
});

// ── T2: assigned + live orch + RECENT updated_at → UNTOUCHED ──────────────────
//
// NEGATIVE CONTROL — deliberately break it first, then restore.
// To break: change runWatchdog to runWatchdogUntilFires (or reduce wedge_timeout_minutes to 1).
// Expected (broken): killCalled becomes true → test RED.
// Restored: killCalled stays false → test GREEN.

describe('orch-wedge assigned-coverage: T2 — assigned+recent does NOT trigger (false-positive guard)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('does NOT restart when orch is alive and assigned task was recently updated [T2]', async () => {
    // Assigned task updated only 5 min ago — well within the 15-min threshold.
    insertOrchAgent(5);
    insertAssignedTask('task-assigned-recent-1', 5, 5);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-should-not-spawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      'T2: killOrchestratorSession must NOT be called when the assigned task updated_at is recent — ' +
      'a healthy assigned task must not trigger a false-positive restart');

    // Task must remain assigned — we did not touch it.
    const taskRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-assigned-recent-1'`);
    assert.equal(taskRows[0]?.status, 'assigned',
      'T2: healthy assigned task must remain assigned');
  });
});

// ── T3: in_progress + STALE → STILL detected (regression guard) ───────────────

describe('orch-wedge assigned-coverage: T3 — in_progress+stale still triggers (regression guard)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('STILL detects and restarts when in_progress task is frozen (regression guard) [T3]', async () => {
    insertOrchAgent(5);
    insertInProgressTask('task-ip-stale-regression', 20);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-t3-respawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'T3: existing in_progress behaviour must be preserved — widening to IN(\'in_progress\',\'assigned\') ' +
      'must not break the in_progress detection path');

    const taskRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-ip-stale-regression'`);
    assert.equal(taskRows[0]?.status, 'pending',
      'T3: GATE 2 must reset the frozen in_progress task to pending');
  });
});

// ── T4: only-if-null hazard — re-assigned task keeps stale assigned_at ────────
//
// The only-if-null rule means: after GATE 2 resets a task to 'pending' and the
// new orch re-assigns it, the stale original assigned_at is preserved (it was non-null
// from the first assignment, so task-state-machine.ts:146 does not overwrite it).
// We construct that row shape here and assert the healthy re-assigned task is NOT killed.
//
// NEGATIVE CONTROL — deliberately break it first, then restore.
// To break: temporarily use status IN ('in_progress','assigned') WITH assigned_at < cutoffIso
//   as a secondary predicate. If such a query existed, a re-assigned task with stale assigned_at
//   would be killed even though its updated_at is recent.
// Expected (broken): killCalled becomes true → test RED.
// Restored: detector uses updated_at only (not assigned_at) → killCalled stays false → GREEN.

describe('orch-wedge assigned-coverage: T4 — stale assigned_at on re-assigned task is NOT treated as wedge', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('does NOT kill a re-assigned task whose assigned_at is stale but updated_at is recent [T4 — LOAD-BEARING NEGATIVE CONTROL]', async () => {
    // Scenario: GATE 2 previously reset a frozen task to 'pending'. The new orch re-assigned it.
    // Because assigned_at is only set when null, the re-assignment preserved the ORIGINAL stale
    // assigned_at from the first assignment cycle. The task is now healthy (orch is working on
    // it — updated_at advances), but assigned_at looks old.
    //
    // Signal(i) reads MAX(updated_at) — NOT assigned_at. So this task must NOT trigger a restart.
    insertOrchAgent(5);

    // Insert as 'assigned' with:
    //   - assigned_at = 25 min ago (stale original from first-assignment cycle)
    //   - updated_at  =  3 min ago (fresh — orch is actively working on it)
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, created_at, assigned_at, updated_at)
       VALUES ('task-t4-reassigned', 'orchestrator', 'Re-assigned task', 'assigned', ?, ?, ?)`,
      isoMinutesAgo(60),
      isoMinutesAgo(25),  // stale assigned_at (from original assignment, preserved by only-if-null)
      isoMinutesAgo(3),   // RECENT updated_at (orch is actively working)
    );

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-should-not-spawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      'T4 (LOAD-BEARING): killOrchestratorSession must NOT be called when assigned_at is stale ' +
      'but updated_at is recent — signal(i) gates on updated_at (MAX), NOT assigned_at; ' +
      'if the detector were accidentally widened to also check assigned_at, this goes RED');

    // Task must remain assigned — we did not touch it.
    const taskRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-t4-reassigned'`);
    assert.equal(taskRows[0]?.status, 'assigned',
      'T4: re-assigned task with stale assigned_at but recent updated_at must remain assigned');
  });
});

// ── T5: exemptions still hold for assigned tasks ───────────────────────────────
//
// The running-worker exemption (#462) and synthesis-grace exemption (#940) are applied
// to signalI generically — they are not status-specific. But we must verify they also
// suppress the widened signal when the offending task is 'assigned' (not just 'in_progress').

describe('orch-wedge assigned-coverage: T5 — exemptions still suppress signal(i) for assigned tasks', () => {
  beforeEach(setup);
  afterEach(teardown);

  /** Insert a running worker_job. */
  function insertRunningWorker(id: string): void {
    exec(
      `INSERT INTO worker_jobs (id, profile, prompt, status, created_at)
       VALUES (?, 'coding', 'test prompt', 'running', ?)`,
      id, isoMinutesAgo(30),
    );
  }

  /** Insert a completed worker_job with finished_at set to the given number of minutes ago. */
  function insertCompletedWorkerJob(id: string, finishedMinutesAgo: number): void {
    exec(
      `INSERT INTO worker_jobs (id, profile, prompt, status, created_at, finished_at)
       VALUES (?, 'coding', 'test prompt', 'completed', ?, ?)`,
      id,
      isoMinutesAgo(60),
      isoMinutesAgo(finishedMinutesAgo),
    );
  }

  it('running-worker exemption (#462) suppresses signal(i) when the task is assigned+stale [T5a]', async () => {
    // Stale assigned task — would trigger signal(i) without the exemption.
    // A running worker means the orch is healthy-waiting; restart must be suppressed.
    insertOrchAgent(5);
    insertAssignedTask('task-t5a-assigned', 20, 10);
    insertRunningWorker('worker-t5a-running');

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-should-not-spawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      'T5a (#462 guard): running worker must suppress signal(i) even when the task is assigned+stale — ' +
      'widening the status predicate must not resurrect kithkit#462');

    // Task must remain assigned — exemption kept us from touching it.
    const taskRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-t5a-assigned'`);
    assert.equal(taskRows[0]?.status, 'assigned',
      'T5a: assigned task must remain assigned when the running-worker exemption fires');
  });

  it('synthesis-grace exemption (#940) suppresses signal(i) for assigned+stale when worker completed recently [T5b]', async () => {
    // Stale assigned task. Worker completed 5 min ago (within default 15-min grace).
    // Orch is in its synthesis phase — restart must be suppressed.
    insertOrchAgent(5);
    insertAssignedTask('task-t5b-assigned', 20, 10);
    insertCompletedWorkerJob('worker-t5b-completed', 5);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-should-not-spawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15, synthesis_grace_minutes: 15 });

    assert.equal(killCalled, false,
      'T5b (#940 guard): synthesis-grace exemption must suppress signal(i) for assigned+stale — ' +
      'widening the status predicate must not resurrect kithkit#558');

    const taskRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-t5b-assigned'`);
    assert.equal(taskRows[0]?.status, 'assigned',
      'T5b: assigned task must remain assigned during synthesis grace window');
  });
});
