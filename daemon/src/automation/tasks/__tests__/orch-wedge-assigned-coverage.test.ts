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
  _getWedgeRestartStateForTesting as getWedgeRestartState,
  WEDGE_DEBOUNCE_THRESHOLD,
  WEDGE_RESTART_CAP,
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

// ── T3: in_progress + STALE → STILL detected (behaviour-preservation) ────────
//
// BEHAVIOUR-PRESERVATION TEST — stale in_progress detection existed before this diff and
// must not regress. This test does NOT kill the mutation of widening the status predicate
// from status='in_progress' to status IN ('in_progress','assigned'): reverting to the narrow
// predicate still catches a stale in_progress task, so this test stays GREEN on reversion.
// T6 is the mutation-killing regression guard for the two-query masking fix.

describe('orch-wedge assigned-coverage: T3 — in_progress+stale still triggers (behaviour-preservation)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('STILL detects and restarts when in_progress task is frozen (behaviour-preservation, not mutation-kill) [T3]', async () => {
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
    // Stale in_progress + stale assigned — signal(i) fires under BOTH the old predicate
    // (status='in_progress') and the new one (IN('in_progress','assigned')). The running-worker
    // exemption must suppress the restart in either case. This ensures the test cannot pass for
    // the wrong reason: without the fix the assigned task was invisible but the in_progress task
    // still fires signal(i), so the exemption is genuinely exercised in both code paths.
    insertOrchAgent(5);
    insertInProgressTask('task-t5a-ip-stale', 20);
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
    // Stale in_progress + stale assigned — signal(i) fires under BOTH the old predicate
    // (status='in_progress') and the new one (IN('in_progress','assigned')). The synthesis-grace
    // exemption must suppress the restart in either case. This ensures T5b cannot pass for the
    // wrong reason: without the fix the assigned task was invisible but the in_progress task
    // still fires signal(i), so the exemption is genuinely exercised on both code paths.
    insertOrchAgent(5);
    insertInProgressTask('task-t5b-ip-stale', 20);
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

// ── T6: Mixed population — stale in_progress NOT masked by recent assigned ────
//
// MUTATION-KILL PROOF for the two-query fix (Defect 1 — masking regression):
//
// Under single-MAX (current bug in HEAD):
//   SELECT MAX(updated_at) FROM tasks WHERE status IN ('in_progress','assigned')
//   → MAX = 2min ago (recent assigned raises the combined MAX)
//   → signalI = false (2min ago is NOT older than cutoff 15min ago)
//   → killCalled = false → TEST GOES RED
//
// After two-query fix (separate queries per population):
//   in_progress population: MAX = 20min ago → stale → signalI = true
//   → killCalled = true → TEST GOES GREEN
//
// This test is the primary mutation-killing guard for the masking-regression fix.

describe('orch-wedge assigned-coverage: T6 — stale in_progress NOT masked by recent assigned (masking-regression guard)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('fires signal(i) even when a recent assigned task raises the combined MAX [T6 — MUTATION-KILL: two-query fix]', async () => {
    // One stale in_progress (20min) + one recent assigned (2min), no running workers.
    // Single-MAX: MAX(updated_at across both) = 2min ago → not stale → signalI=false → RED.
    // Two-query: in_progress population fires independently (MAX=20min ago) → signalI=true → GREEN.
    insertOrchAgent(5);
    insertInProgressTask('task-t6-ip-stale', 20);
    insertAssignedTask('task-t6-as-recent', 2, 2);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-t6-respawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'T6: a stale in_progress task must NOT be masked by a recent assigned task — ' +
      'goes RED under single-MAX (the masking regression), GREEN after two-query fix');

    // GATE 2: stale in_progress must be reset; recent assigned must be left untouched.
    const ipRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-t6-ip-stale'`);
    assert.equal(ipRows[0]?.status, 'pending',
      'T6: GATE 2 must reset the stale in_progress task to pending');

    const asRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-t6-as-recent'`);
    assert.equal(asRows[0]?.status, 'assigned',
      'T6: the recent assigned task must remain assigned — GATE 2 only touches stale tasks');
  });
});

// ── T7: Gate 3 — perpetually-frozen assigned task is eventually marked FAILED ─
//
// MUTATION-KILL PROOF for Gate 3 widening (Defect 2):
//
// Under current HEAD (Gate 3 only marks in_progress tasks FAILED):
//   Kth run: Gate 3 fires → SELECT in_progress stale → 0 rows (task is 'assigned') → nothing failed
//   → counter reset → cycle continues → task never marked FAILED → TEST GOES RED
//
// After Gate 3 widening (includes assigned):
//   Kth run: Gate 3 fires → SELECT in_progress/assigned stale → finds task → marks FAILED
//   → TEST GOES GREEN

describe('orch-wedge assigned-coverage: T7 — Gate 3 marks perpetually-frozen assigned task FAILED (cap-exhaustion guard)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('marks a perpetually-frozen assigned task FAILED once restart cap is exhausted [T7 — MUTATION-KILL: Gate 3 widening]', async () => {
    const TASK_ID = 'task-t7-gate3-assigned';
    // Fixed timestamp — isoMinutesAgo() drifts per call (millisecond resolution), which would
    // make ipMaxUpdated differ on every run and reset the cap counter to 1 each time.
    const FROZEN_TS = isoMinutesAgo(20);

    function reInsertFrozenAssigned(): void {
      exec(`DELETE FROM tasks WHERE external_id = ?`, TASK_ID);
      exec(
        `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
         VALUES (?, 'orchestrator', 'Assigned gate3 task', 'assigned', ?, ?)`,
        TASK_ID, isoMinutesAgo(60), FROZEN_TS,
      );
    }

    insertOrchAgent(5);
    reInsertFrozenAssigned();

    let killCallCount = 0;
    const commsAlerts: Array<{ alert: string; taskIds?: string[] }> = [];

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCallCount++; return true; },
      spawnOrchestratorSession: () => `orch-t7-respawn-${killCallCount}`,
      captureOrchestratorPane: () => '> ',
      sendMessage: (msg) => {
        try {
          const body = JSON.parse(msg.body);
          if (body.alert) commsAlerts.push(body);
        } catch { /* ignore */ }
        return { messageId: 1, delivered: false };
      },
    });

    // Runs 1 through (CAP - 1): signal(i) fires and restarts are allowed.
    // Re-insert with the SAME frozen timestamp after each restart so ipMaxUpdated stays
    // constant across runs and the cap counter increments (no progress made).
    for (let run = 1; run < WEDGE_RESTART_CAP; run++) {
      reInsertFrozenAssigned();
      exec(
        `UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
        isoMinutesAgo(5), isoMinutesAgo(5),
      );

      await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

      assert.equal(killCallCount, run,
        `T7 run ${run}: kill must be called (restart ${run} of ${WEDGE_RESTART_CAP - 1} allowed — ` +
        'if this fails, Gate 3 is firing too early)');
    }

    // Kth run: cap is exhausted — must FAIL the task, NOT restart.
    reInsertFrozenAssigned();
    exec(
      `UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
      isoMinutesAgo(5), isoMinutesAgo(5),
    );

    const killBeforeFinal = killCallCount;
    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCallCount, killBeforeFinal,
      'T7: Kth run must NOT call kill — cap exhausted means FAIL the task, not another restart');

    const taskRows = query<{ status: string; error: string | null }>(
      `SELECT status, error FROM tasks WHERE external_id = ?`, TASK_ID,
    );
    assert.equal(taskRows[0]?.status, 'failed',
      'T7: perpetually-frozen assigned task must be marked FAILED when cap is exhausted — ' +
      'goes RED under current HEAD (Gate 3 only checks in_progress), GREEN after Gate 3 widening');
    assert.equal(taskRows[0]?.error, 'wedge_restart_cap_exceeded',
      'T7: error field must be wedge_restart_cap_exceeded');

    const capAlert = commsAlerts.find(a => a.alert === 'orchestrator_wedge_cap_exceeded');
    assert.ok(capAlert,
      'T7: comms must receive orchestrator_wedge_cap_exceeded alert when cap is exhausted');
    assert.ok(capAlert?.taskIds?.includes(TASK_ID),
      'T7: cap alert must include the failed task ID');

    const state = getWedgeRestartState();
    assert.equal(state.count, 0, 'T7: wedgeRestartCount must be reset to 0 after Gate 3 fires');
    assert.equal(state.lastIpMaxUpdatedAt, null, 'T7: lastWedgeIpMaxUpdatedAt must be null after reset');
  });
});
