/**
 * Mutation-kill tests: orchestrator alive-but-wedged detector (fix(2), #2304/#1946/#448).
 *
 * Tests the wedge detector added to context-watchdog.monitorOrchestratorWedge().
 *
 * PRIMARY ASSERTION:
 *   An orchestrator reported ALIVE with an in_progress task whose updated_at is
 *   frozen beyond the threshold → killOrchestratorSession IS called (auto-restart).
 *
 * MUTATION-KILL PROOF:
 *   GREEN with the wedge-detection branch.
 *   RED  when the wedge-detection branch is removed/reverted — killCalled stays false.
 *
 * FALSE-POSITIVE GUARD:
 *   A healthy alive orch (recent updated_at) is NOT killed.
 *   Ensures the detector does not fire on a working orchestrator.
 *
 * Signal (ii) test:
 *   agents.last_activity frozen beyond threshold → auto-restart fires.
 *
 * Signal (iii) test:
 *   Pane shows feedback prompt → auto-restart fires.
 *
 * CI placement: daemon/src/automation/tasks/__tests__/ compiles to
 * daemon/dist/automation/tasks/__tests__/, found by `node --test dist/**\/*.test.js`.
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
  DEFAULT_WEDGE_TIMEOUT_MINUTES,
  WEDGE_RESTART_CAP,
  WEDGE_DEBOUNCE_THRESHOLD,
} from '../context-watchdog.js';

// ── Helpers ───────────────────────────────────────────────────

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function isoMinutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/**
 * Signal (i)/(ii) require WEDGE_DEBOUNCE_THRESHOLD consecutive ticks before the wedge
 * detector acts (see the DEBOUNCE GATE in context-watchdog.ts). Signal (iii) bypasses
 * debounce and fires on a single tick. Tests that expect a signal(i)/(ii)-driven restart
 * must "prime" the debounce counter with (WEDGE_DEBOUNCE_THRESHOLD - 1) no-op ticks before
 * the tick that actually fires — a single `runWatchdog()` call is not sufficient. Call this
 * instead of `runWatchdog()` directly whenever the test asserts a signal(i)/(ii) restart DID happen.
 */
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-wedge-'));
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

/** Insert a running orchestrator agent with given last_activity and started_at. */
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

/** Insert an in_progress task with the given updated_at age in minutes. */
function insertInProgressTask(extId: string, updatedMinutesAgo: number): void {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Test task', 'in_progress', ?, ?)`,
    extId,
    isoMinutesAgo(60),
    isoMinutesAgo(updatedMinutesAgo),
  );
}

/** Insert a pending orchestrator task (open-queue entry, not in_progress). */
function insertPendingTask(extId: string): void {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Pending task', 'pending', ?, ?)`,
    extId,
    isoMinutesAgo(30),
    isoMinutesAgo(30),
  );
}

/** Insert a completed orchestrator task with acknowledged_at left NULL. */
function insertCompletedTask(extId: string, updatedMinutesAgo: number): void {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at, completed_at, acknowledged_at)
     VALUES (?, 'orchestrator', 'Completed task', 'completed', ?, ?, ?, NULL)`,
    extId,
    isoMinutesAgo(60),
    isoMinutesAgo(updatedMinutesAgo),
    isoMinutesAgo(updatedMinutesAgo),
  );
}

// ── Primary mutation-kill test ─────────────────────────────────

describe('orch-wedge-detector: signal (i) — frozen in_progress task (mutation-kill)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('KILLS and respawns the orchestrator when alive but in_progress task frozen beyond threshold', async () => {
    // Orch alive with FRESH last_activity (5 min) — isolates signal(i) from signal(ii).
    // in_progress task updated 20 min ago (default threshold = 15 min) — triggers signal(i).
    // Without this isolation, signal(ii) would also fire when last_activity is stale,
    // making the test pass even if signal(i) logic is removed (not mutation-killing).
    insertOrchAgent(5);  // fresh last_activity — signal(ii) must NOT fire
    insertInProgressTask('task-frozen-1', 20);

    let killCalled = false;
    let spawnCalled = false;
    const commsMessages: string[] = [];

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => { spawnCalled = true; return 'orch1'; },
      captureOrchestratorPane: () => '> ',  // normal pane — no signal (iii)
      sendMessage: (msg) => {
        commsMessages.push(msg.body);
        return { messageId: 1, delivered: false };
      },
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'killOrchestratorSession MUST be called when orch is alive but in_progress task is frozen — ' +
      'if this fails, the wedge-detection branch was removed (mutation-kill proof)');
    assert.equal(spawnCalled, true,
      'spawnOrchestratorSession MUST be called to restart after kill');

    const commsAlert = commsMessages.find(b => {
      try { return JSON.parse(b)?.alert === 'orchestrator_wedge_restart'; } catch { return false; }
    });
    assert.ok(commsAlert, 'comms must be notified of the wedge restart');
  });

  it('does NOT kill when in_progress task was recently updated (false-positive guard)', async () => {
    // Task updated only 5 minutes ago — well within the 15-min threshold
    insertOrchAgent(5);
    insertInProgressTask('task-recent-1', 5);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      'killOrchestratorSession must NOT be called when the in_progress task was recently updated');
  });

  it('does NOT kill when there are no in_progress tasks (healthy orch with no active work)', async () => {
    insertOrchAgent(5);
    // No tasks inserted — no in_progress tasks

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    // Even with stale last_activity, no in_progress → signal (i) does not fire alone here.
    // We need all three signals to NOT fire for no kill.
    // Use recent last_activity and normal pane to ensure no other signals fire.
    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    // Signal (i): no in_progress → no fire
    // Signal (ii): last_activity 5 min ago < 15 min threshold → no fire
    // Signal (iii): pane = '> ' → no fire
    assert.equal(killCalled, false,
      'killOrchestratorSession must NOT be called when there are no in_progress tasks and last_activity is fresh');
  });

  it('does NOT kill when orchestrator is dead (isOrchestratorAlive returns false)', async () => {
    insertOrchAgent(20);
    insertInProgressTask('task-dead-orch-1', 20);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => false,  // orch is dead — wedge detector must skip
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      'wedge detector must not fire when orch is dead — other monitors handle the dead-orch case');
  });
});

// ── Signal (ii): frozen last_activity ─────────────────────────

describe('orch-wedge-detector: signal (ii) — frozen agents.last_activity', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('KILLS orchestrator when alive but last_activity frozen beyond threshold (with open queue work)', async () => {
    // last_activity 20 min ago, one pending task in queue, normal pane.
    // Signal (i) does not fire (no in_progress task). Signal (ii) fires because the
    // orch has an open pending task it is ignoring while last_activity is frozen.
    // NOTE: per #922, an orch with frozen last_activity but an EMPTY queue is idle,
    // not wedged. A pending task is included here so signal(ii) legitimately fires.
    insertOrchAgent(20);
    insertPendingTask('task-signal2-pending-baseline');

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'killOrchestratorSession MUST be called when last_activity is frozen and the orch is ignoring open queue work');
  });

  it('respects custom wedge_timeout_minutes config knob', async () => {
    // last_activity 10 min ago — would NOT trigger at default 15 min, but SHOULD at custom 8 min.
    // A pending task is present so the idle-queue exemption (#922) does not suppress signal(ii):
    // the orch has open work it is ignoring.
    insertOrchAgent(10);
    insertPendingTask('task-knob-test-pending');

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    // With default threshold (15): should NOT fire
    await runWatchdog({ wedge_timeout_minutes: 15 });
    assert.equal(killCalled, false, 'must NOT fire at 15-min threshold when last_activity is 10 min ago');

    // With custom threshold (8): should fire
    await runWatchdogUntilFires({ wedge_timeout_minutes: 8 });
    assert.equal(killCalled, true, 'MUST fire at 8-min threshold when last_activity is 10 min ago');
  });

  it('DEFAULT_WEDGE_TIMEOUT_MINUTES is 15 (regression guard)', () => {
    assert.equal(DEFAULT_WEDGE_TIMEOUT_MINUTES, 15,
      'Default wedge timeout must be 15 minutes — change this test if you intentionally change the default');
  });

  // ── Idle / empty-queue exemption (#922) ───────────────────────────────────
  //
  // Signal (ii) — frozen last_activity — must NOT restart the orchestrator when the
  // task queue is entirely empty (no pending / assigned / in_progress tasks).
  // An idle orch legitimately has frozen last_activity: it has no turns when there
  // is nothing to do. This is not a wedge; it is a stood-down state.
  //
  // MUTATION-KILL PROOF for the idle-queue exemption:
  // Revert: remove the empty-queue check so `signalII = true` fires unconditionally
  //   (restore the old `else { signalII = true; }` without the open-task guard).
  // Expected: spawnCalled becomes true → test 1 goes RED.
  // Restored: spawnCalled stays false → test 1 GREEN.
  //
  // NARROWNESS: the exemption is scoped tightly — test 2 proves that the same frozen
  // last_activity WITH a pending task still triggers a restart (orch ignoring open work).

  it('does NOT restart orch when last_activity is frozen and task queue is EMPTY — idle/stood-down exemption (#922) [MUTATION-KILL]', async () => {
    // last_activity frozen 20 min ago (> 15 min threshold).
    // NO tasks in queue (pending / assigned / in_progress = 0) — orch is idle.
    // NO running workers.
    // Normal pane — signal (iii) does not fire.
    // Signal (i) does not fire (no in_progress task).
    // Signal (ii) must NOT fire: empty queue = legitimately idle, not wedged.
    insertOrchAgent(20);
    // Intentionally no tasks inserted — queue is empty.

    let spawnCalled = false;
    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => { spawnCalled = true; return 'orch-should-not-spawn'; },
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(spawnCalled, false,
      '#922: spawnOrchestratorSession must NOT be called when last_activity is frozen but the ' +
      'task queue is empty — the orch is idle/stood-down, not wedged; removing the ' +
      'idle-queue exemption makes this RED (mutation-kill proof)');
    assert.equal(killCalled, false,
      '#922: killOrchestratorSession must NOT be called when orch is idle with empty queue');
  });

  it('STILL restarts orch when last_activity is frozen, no workers, but a pending task is waiting — exemption is narrow (#922) [NARROWNESS GUARD]', async () => {
    // last_activity frozen 20 min ago, no running workers, normal pane.
    // ONE pending task in queue — the orch is ignoring open work.
    // Signal (i) does not fire (pending != in_progress).
    // Signal (ii) MUST fire: frozen last_activity + open queue work = wedged.
    // This test proves the exemption does not mask a genuine stuck-ignoring-queue case.
    insertOrchAgent(20);
    insertPendingTask('task-922-narrowness-pending');

    let spawnCalled = false;
    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => { spawnCalled = true; return 'orch-respawned-narrowness'; },
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(spawnCalled, true,
      '#922 narrowness: spawnOrchestratorSession MUST be called when last_activity is frozen ' +
      'and a pending task is waiting — the exemption must not suppress a wedged orch ignoring open work; ' +
      'making the exemption unconditional (always skip signal(ii)) would make this RED');
    assert.equal(killCalled, true,
      '#922 narrowness: killOrchestratorSession MUST be called when orch is wedged with pending work');
  });
});

// ── Signal (iii): pane text ────────────────────────────────────

describe('orch-wedge-detector: signal (iii) — pane shows feedback prompt or garbled XML', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('KILLS orchestrator when pane shows "How is Claude doing this session" (feedback prompt)', async () => {
    // Recent last_activity and no frozen tasks — only signal (iii) should fire
    insertOrchAgent(2);  // last_activity 2 min ago — well within threshold

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => 'How is Claude doing this session?\n> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'killOrchestratorSession MUST be called when pane shows the feedback prompt');
  });

  it('KILLS orchestrator when pane shows garbled literal XML (<invoke)', async () => {
    insertOrchAgent(2);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '<invoke name="Bash"><parameter name="command">ls</parameter></invoke>\n> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'killOrchestratorSession MUST be called when pane shows garbled XML tool invocations');
  });

  it('does NOT kill when pane is normal (no wedge signals)', async () => {
    insertOrchAgent(2);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => 'Working on task...\n> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      'must NOT kill when pane is normal and last_activity is fresh');
  });
});

// ── Fix(2)/Fix(3) coordination: started_at refresh on respawn ──

describe('orch-wedge-detector: started_at refreshed on respawn (fix(2)/fix(3) coordination)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('updates agents.started_at when respawning (so fix(3) stale-timer guard sees new identity)', async () => {
    insertOrchAgent(20);
    insertInProgressTask('task-coord-1', 20);

    const oldStartedAt = isoMinutesAgo(60);
    // agents row already has started_at = isoMinutesAgo(60) from insertOrchAgent(20, 60)

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => 'orch1-new',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    // Signal (i)/(ii)-driven restarts are gated behind WEDGE_DEBOUNCE_THRESHOLD (2)
    // consecutive ticks (see monitorOrchestratorWedge's debounce gate) — a single tick
    // only increments the debounce counter and returns without restarting. Drive two
    // ticks so the restart (and its started_at refresh) actually fires, instead of
    // asserting on a restart that never happened. Without this, `newStartedAt` is just
    // the original insertOrchAgent() value re-read from the DB, and the assertion below
    // passes or fails purely on whether that value happens to collide (same millisecond)
    // with the independently-computed `oldStartedAt` — a flaky, meaningless comparison.
    await runWatchdog({ wedge_timeout_minutes: 15 });
    await runWatchdog({ wedge_timeout_minutes: 15 });

    // After wedge restart, the agents table should have a new (fresher) started_at
    const rows = query<{ started_at: string | null }>(
      "SELECT started_at FROM agents WHERE id = 'orchestrator'",
    );
    const newStartedAt = rows[0]?.started_at ?? null;

    assert.ok(newStartedAt !== null, 'agents.started_at must be set after wedge restart');
    assert.notEqual(newStartedAt, oldStartedAt,
      'agents.started_at MUST be updated to a fresh timestamp on respawn — ' +
      'fix(3) stale-timer guard depends on this to distinguish the new session');
  });
});

// ── GATE 2: task reset to pending on wedge-restart ─────────────────────────────────────────────

describe('orch-wedge-detector: GATE 2 — wedge-restart resets frozen in_progress task to pending', () => {
  beforeEach(setup);
  afterEach(teardown);

  /**
   * MUTATION-KILL PROOF for GATE 2:
   * Revert: remove the GATE 2 exec() call in restartWedgedOrchestrator().
   * Expected: task status remains 'in_progress' after restart → test goes RED.
   * Restored: task status becomes 'pending' → test GREEN.
   *
   * Why this matters: the fresh orch polls ?status=pending only. Without the reset the
   * task stays in_progress with no owner — an orphan that neither the new orch picks up
   * nor signal(i) ever clears (updated_at stays frozen → infinite restart storm).
   */
  it('RESETS frozen in_progress task to pending when wedge-restart fires (GATE 2)', async () => {
    insertOrchAgent(5);  // fresh last_activity — only signal(i) fires
    insertInProgressTask('task-gate2-1', 20);  // frozen 20 min (> 15 min threshold)

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => 'orch-new-1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    // After wedge restart, the task MUST be pending (not in_progress) so the fresh orch picks it up
    const taskRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-gate2-1'`);
    assert.equal(taskRows[0]?.status, 'pending',
      'GATE 2: frozen in_progress task MUST be reset to pending on wedge-restart — ' +
      'without this the fresh orch cannot pick it up (polls pending-only) and the ' +
      'task is orphaned; removing the GATE 2 exec() makes this RED');
  });

  it('GATE 5 preserved: progressing orch (updated_at advancing) is NOT restarted', async () => {
    // Task updated only 5 min ago — well within the 15-min threshold
    insertOrchAgent(5);
    insertInProgressTask('task-gate5-healthy', 5);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-new',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      'GATE 5: a progressing orchestrator (task updated_at within threshold) must NOT be restarted');

    // Task must still be in_progress — we did not touch it
    const taskRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-gate5-healthy'`);
    assert.equal(taskRows[0]?.status, 'in_progress',
      'GATE 5: task must remain in_progress when orch is healthy');
  });
});

// ── GATE 2: blast-radius scoping ────────────────────────────────────────────────────────────────

describe('orch-wedge-detector: GATE 2 — blast-radius scoping (only the wedged task is reset)', () => {
  beforeEach(setup);
  afterEach(teardown);

  /**
   * MUTATION-KILL PROOF:
   * Revert: drop the `AND updated_at < ?` staleness scoping from GATE 2's SELECT/UPDATE
   * (restore the old blanket `WHERE kind = 'orchestrator' AND status = 'in_progress'`).
   * Expected: the healthy task also gets reset to pending → test goes RED.
   * Restored: only the frozen task is reset; the healthy one stays in_progress → GREEN.
   *
   * NOTE on trigger choice: this test fires the restart via signal (iii) (pane shows
   * garbled tool-invocation XML) rather than signal (i) (frozen in_progress MAX(updated_at)).
   * signal (i) is computed as MAX(updated_at) across ALL in_progress orchestrator tasks —
   * if ANY concurrent task is fresh (like task-gate2-healthy here), it dominates the MAX
   * and signal (i) can mathematically never fire. Signal (iii) is independent of task-table
   * state and is the only signal that can realistically coexist with a healthy concurrent
   * task, so it's the correct way to exercise GATE 2's blast-radius scoping here.
   */
  it('resets ONLY the wedged task when TWO concurrent in_progress orchestrator tasks exist and only one is frozen', async () => {
    insertOrchAgent(5); // fresh last_activity — isolate to signal(iii) only
    insertInProgressTask('task-gate2-healthy', 2);   // recently updated — NOT wedged
    insertInProgressTask('task-gate2-wedged', 20);    // frozen 20 min (> 15 min threshold)

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => 'orch-gate2-blast-radius',
      captureOrchestratorPane: () => '<invoke name="Bash"><parameter name="command">ls</parameter></invoke>\n> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    const wedgedRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-gate2-wedged'`);
    assert.equal(wedgedRows[0]?.status, 'pending',
      'GATE 2: the frozen task MUST be reset to pending');

    const healthyRows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = 'task-gate2-healthy'`);
    assert.equal(healthyRows[0]?.status, 'in_progress',
      'GATE 2: a concurrent HEALTHY in_progress task must NOT be reset — blast-radius scoping must ' +
      'target only the task(s) whose updated_at is actually stale; reverting to the blanket ' +
      "WHERE status = 'in_progress' UPDATE makes this RED (mutation-kill proof)");
  });

  /**
   * MUTATION-KILL PROOF:
   * Revert: drop the `AND status = 'in_progress'` defense-in-depth filter from GATE 2's UPDATE.
   * Expected: nothing changes in THIS test alone (row is already excluded by staleness), but
   * combined with a wider selection query the completed row could be reachable. This test locks
   * the invariant directly: a completed task is NEVER touched by GATE 2 regardless of signal state.
   */
  it('NEVER touches a completed task (acknowledged_at=NULL) even when the wedge fires', async () => {
    insertOrchAgent(5);
    insertInProgressTask('task-gate2-wedged-2', 20); // triggers the restart
    insertCompletedTask('task-gate2-completed', 30);  // old, completed, unacknowledged — must stay terminal

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => 'orch-gate2-terminal-guard',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    const completedRows = query<{ status: string; acknowledged_at: string | null }>(
      `SELECT status, acknowledged_at FROM tasks WHERE external_id = 'task-gate2-completed'`,
    );
    assert.equal(completedRows[0]?.status, 'completed',
      'GATE 2: a completed task must remain completed — terminal status is never requeued, ' +
      'regardless of acknowledged_at or wedge signals');
    assert.equal(completedRows[0]?.acknowledged_at, null,
      'GATE 2: acknowledged_at must be untouched (sanity check on the fixture)');
  });
});

// ── GATE 3: restart-loop cap ───────────────────────────────────────────────────────────────────

describe('orch-wedge-detector: GATE 3 — restart cap bounds the wedge-restart loop', () => {
  beforeEach(setup);
  afterEach(teardown);

  /**
   * Helper: re-insert task as in_progress with the SAME frozen updated_at.
   * Simulates the fresh orch immediately re-wedging on the same task (no progress made).
   */
  function reInsertInProgressTask(extId: string, updatedMinutesAgo: number): void {
    exec(`DELETE FROM tasks WHERE external_id = ?`, extId);
    insertInProgressTask(extId, updatedMinutesAgo);
  }

  /**
   * MUTATION-KILL PROOF for GATE 3:
   * Revert: remove the `if (wedgeRestartCount >= WEDGE_RESTART_CAP)` cap check (return without failing).
   * Expected: killCalled on ALL runs including the Kth → task never marked FAILED → test goes RED
   *   (killCallCount > expected, commsCapAlert never set).
   * Restored: killCalled on first (CAP-1) runs only; Kth run skips kill and marks FAILED → GREEN.
   */
  it('FAILS task and alerts comms on Kth consecutive no-progress restart (not infinite) — GATE 3', async () => {
    const TASK_ID = 'task-gate3-loop';

    // Use a FIXED frozen timestamp for all insertions — isoMinutesAgo() recalculates each call
    // (millisecond drift per call), causing the counter to see a "new" epoch every run and reset
    // to 1 instead of incrementing. A fixed value ensures ipMaxUpdated is the same across all runs.
    const FROZEN_TS = isoMinutesAgo(20);

    /** Re-insert task as in_progress with the identical frozen timestamp (no millisecond drift). */
    function reInsertFrozen(): void {
      exec(`DELETE FROM tasks WHERE external_id = ?`, TASK_ID);
      exec(
        `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
         VALUES (?, 'orchestrator', 'Test task', 'in_progress', ?, ?)`,
        TASK_ID, isoMinutesAgo(60), FROZEN_TS,
      );
    }

    insertOrchAgent(5);
    reInsertFrozen();

    let killCallCount = 0;
    let spawnCallCount = 0;
    const commsAlerts: Array<{ alert: string; taskIds?: string[] }> = [];

    const deps = {
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCallCount++; return true; },
      spawnOrchestratorSession: () => { spawnCallCount++; return `orch-respawn-${spawnCallCount}`; },
      captureOrchestratorPane: () => '> ',
      sendMessage: (msg: { body: string }) => {
        try {
          const body = JSON.parse(msg.body);
          if (body.alert) commsAlerts.push(body);
        } catch { /* ignore */ }
        return { messageId: 1, delivered: false };
      },
    };
    setWedgeDeps(deps);

    // Runs 1 through (CAP - 1): each should restart and reset task to pending.
    // We re-insert as in_progress with the SAME frozen timestamp after each run to simulate
    // the fresh orch immediately re-wedging (no updated_at progress).
    // NOTE: we UPDATE last_activity (not re-INSERT agents) because insertOrchAgent() does a plain
    // INSERT which would fail with UNIQUE constraint after the first restart writes the row.
    for (let run = 1; run < WEDGE_RESTART_CAP; run++) {
      // Task must be in_progress with the same frozen timestamp for signal(i) to fire
      reInsertFrozen();
      // Keep last_activity fresh so only signal(i) fires (not signal(ii))
      exec(`UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
        isoMinutesAgo(5), isoMinutesAgo(5));

      await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

      assert.equal(killCallCount, run,
        `Run ${run}: killOrchestratorSession MUST be called (restart ${run} of ${WEDGE_RESTART_CAP - 1} allowed) — ` +
        'if this fails, GATE 3 is firing too early');
    }

    // Kth run (count reaches WEDGE_RESTART_CAP): must FAIL the task, NOT restart
    reInsertFrozen();
    exec(`UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
      isoMinutesAgo(5), isoMinutesAgo(5));

    const killBeforeFinal = killCallCount;
    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    // Kill must NOT have been called on the final run
    assert.equal(killCallCount, killBeforeFinal,
      `Kth run: killOrchestratorSession must NOT be called when restart cap is reached — ` +
      'task must be FAILED instead of re-queued; removing the GATE 3 cap check makes this RED');

    // Task must now be marked FAILED (not pending/in_progress)
    const taskRows = query<{ status: string; error: string | null }>(
      `SELECT status, error FROM tasks WHERE external_id = ?`, TASK_ID,
    );
    assert.equal(taskRows[0]?.status, 'failed',
      'GATE 3: task must be marked FAILED when restart cap is exhausted');
    assert.equal(taskRows[0]?.error, 'wedge_restart_cap_exceeded',
      'GATE 3: task error must be wedge_restart_cap_exceeded');

    // Comms must be alerted with the cap-exceeded alert
    const capAlert = commsAlerts.find(a => a.alert === 'orchestrator_wedge_cap_exceeded');
    assert.ok(capAlert,
      'GATE 3: comms MUST be alerted with orchestrator_wedge_cap_exceeded when cap is exhausted');
    assert.ok(capAlert?.taskIds?.includes(TASK_ID),
      'GATE 3: comms alert must include the failed task ID');

    // Restart counter must be reset so future tasks start fresh
    const state = getWedgeRestartState();
    assert.equal(state.count, 0, 'GATE 3: wedgeRestartCount must be reset to 0 after failing the task');
    assert.equal(state.lastIpMaxUpdatedAt, null, 'GATE 3: lastWedgeIpMaxUpdatedAt must be null after reset');
  });

  it('GATE 3 counter resets when task makes progress between restarts', async () => {
    // First detection: task frozen → restart (count=1)
    insertOrchAgent(5);
    insertInProgressTask('task-gate3-progress', 20);

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => 'orch-p1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    let state = getWedgeRestartState();
    assert.equal(state.count, 1, 'After first detection: count should be 1');

    // Now simulate progress: re-insert task with NEWER updated_at (only 5 min ago)
    // This represents the fresh orch making real progress.
    // NOTE: no need to call insertOrchAgent again — row exists from initial setup,
    // last_activity remains fresh throughout (restartWedgedOrchestrator doesn't clear it).
    exec(`DELETE FROM tasks WHERE external_id = 'task-gate3-progress'`);
    insertInProgressTask('task-gate3-progress', 5);  // recently updated

    await runWatchdog({ wedge_timeout_minutes: 15 });

    // Task is not frozen (5 min < 15 min threshold) → signal(i) does NOT fire → no kill
    // Counter must remain at 1 from before but task was healthy so no change
    const taskRows = query<{ status: string }>(
      `SELECT status FROM tasks WHERE external_id = 'task-gate3-progress'`,
    );
    assert.equal(taskRows[0]?.status, 'in_progress',
      'A progressing task (within threshold) must NOT be failed or reset — GATE 3 must not trigger');

    // Now freeze the task again with a DIFFERENT (newer) frozen value.
    // This should reset the counter to 1 (new frozen epoch), not continue incrementing.
    exec(`DELETE FROM tasks WHERE external_id = 'task-gate3-progress'`);
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
       VALUES ('task-gate3-progress', 'orchestrator', 'Test task', 'in_progress', ?, ?)`,
      isoMinutesAgo(60),
      isoMinutesAgo(20),
    );
    // Keep last_activity fresh (UPDATE not INSERT — row exists)
    exec(`UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
      isoMinutesAgo(5), isoMinutesAgo(5));

    // Record the new ipMaxUpdated value that will be seen
    const newFrozenRows = query<{ max_updated_at: string | null }>(
      `SELECT MAX(updated_at) as max_updated_at FROM tasks WHERE kind = 'orchestrator' AND status = 'in_progress'`,
    );
    const newFrozenValue = newFrozenRows[0]?.max_updated_at ?? '';

    // The current lastWedgeIpMaxUpdatedAt may have been set to the old frozen value
    // A different frozen value should RESET the counter (not continue incrementing)
    let killCount = 0;
    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCount++; return true; },
      spawnOrchestratorSession: () => 'orch-p2',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    state = getWedgeRestartState();
    assert.equal(state.count, 1,
      'When a different (new) frozen updated_at is detected, the counter must RESET to 1 — ' +
      'this is a new frozen epoch, not a continuation of the previous one');
    assert.equal(state.lastIpMaxUpdatedAt, newFrozenValue,
      'lastWedgeIpMaxUpdatedAt must track the current frozen value');
    assert.equal(killCount, 1, 'Kill must have been called for the new frozen epoch restart');
  });
});

// ── GATE 3: blast-radius scoping ────────────────────────────────────────────────────────────────

describe('orch-wedge-detector: GATE 3 — blast-radius scoping (only the wedged task is failed)', () => {
  beforeEach(setup);
  afterEach(teardown);

  /**
   * MUTATION-KILL PROOF:
   * Revert: drop the `AND updated_at < ?` staleness scoping from GATE 3's SELECT/UPDATE
   * (restore the old blanket `WHERE kind = 'orchestrator' AND status = 'in_progress'`).
   * Expected: only ONE of the two stale tasks would still end up failed by coincidence of the
   * old single-row UPDATE semantics being over-broad, but the real risk the blanket WHERE
   * exposes is unscoped writes to tasks outside the wedge signal entirely; this test instead
   * locks the positive-path invariant that the `external_id IN (...)` scoping is a real list,
   * not a single id — both stale tasks must be swept together. If the multi-id IN clause was
   * silently collapsed to a single id (e.g. `= ?` instead of `IN (...)`) this test goes RED.
   *
   * NOTE on scenario choice: an earlier version of this test set up ONE stale task alongside a
   * HEALTHY (fresh) concurrent task and asserted the healthy one survives GATE 3. That scenario
   * is mathematically impossible to construct: GATE 3's fail-path is nested inside
   * `if (signalI)`, and signalI = MAX(updated_at) across ALL in_progress orchestrator tasks <
   * cutoff. A single fresh task's updated_at always dominates that MAX, so signalI (and
   * therefore GATE 3) can never fire while a genuinely healthy concurrent task exists. Whenever
   * GATE 3 fires, EVERY concurrent in_progress task is, by construction, already stale — so the
   * meaningful blast-radius property to test here is "all currently-stale tasks are swept
   * together by the IN (...) clause," not "a healthy task survives."
   */
  it('fails ALL currently-stale in_progress tasks together when cap exhaustion fires (multi-task IN(...) scoping)', async () => {
    const WEDGED_A = 'task-gate3-blast-wedged-a';
    const WEDGED_B = 'task-gate3-blast-wedged-b';
    const FROZEN_TS = isoMinutesAgo(20);

    function reInsertFrozen(): void {
      exec(`DELETE FROM tasks WHERE external_id IN (?, ?)`, WEDGED_A, WEDGED_B);
      exec(
        `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
         VALUES (?, 'orchestrator', 'Test task A', 'in_progress', ?, ?)`,
        WEDGED_A, isoMinutesAgo(60), FROZEN_TS,
      );
      exec(
        `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
         VALUES (?, 'orchestrator', 'Test task B', 'in_progress', ?, ?)`,
        WEDGED_B, isoMinutesAgo(60), FROZEN_TS,
      );
    }

    insertOrchAgent(5);
    reInsertFrozen();

    let killCallCount = 0;
    const commsAlerts: Array<{ alert: string; taskIds?: string[] }> = [];

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCallCount++; return true; },
      spawnOrchestratorSession: () => `orch-gate3-blast-${killCallCount}`,
      captureOrchestratorPane: () => '> ',
      sendMessage: (msg: { body: string }) => {
        try {
          const body = JSON.parse(msg.body);
          if (body.alert) commsAlerts.push(body);
        } catch { /* ignore */ }
        return { messageId: 1, delivered: false };
      },
    });

    // Drive both wedged tasks through CAP-1 restarts, then the Kth run trips GATE 3.
    for (let run = 1; run < WEDGE_RESTART_CAP; run++) {
      reInsertFrozen();
      exec(`UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
        isoMinutesAgo(5), isoMinutesAgo(5));
      await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });
    }
    reInsertFrozen();
    exec(`UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
      isoMinutesAgo(5), isoMinutesAgo(5));
    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    const rowsA = query<{ status: string; error: string | null }>(
      `SELECT status, error FROM tasks WHERE external_id = ?`, WEDGED_A,
    );
    const rowsB = query<{ status: string; error: string | null }>(
      `SELECT status, error FROM tasks WHERE external_id = ?`, WEDGED_B,
    );
    assert.equal(rowsA[0]?.status, 'failed',
      'GATE 3: stale task A must be marked FAILED by the multi-task IN(...) scoping');
    assert.equal(rowsA[0]?.error, 'wedge_restart_cap_exceeded');
    assert.equal(rowsB[0]?.status, 'failed',
      'GATE 3: stale task B must ALSO be marked FAILED — the IN(...) clause must not silently ' +
      'drop tasks beyond the first when multiple tasks are simultaneously stale');
    assert.equal(rowsB[0]?.error, 'wedge_restart_cap_exceeded');

    const capAlert = commsAlerts.find(a => a.alert === 'orchestrator_wedge_cap_exceeded');
    assert.ok(capAlert, 'GATE 3: comms must be alerted with the cap-exceeded alert');
    assert.ok(capAlert?.taskIds?.includes(WEDGED_A), 'GATE 3: alert must include task A');
    assert.ok(capAlert?.taskIds?.includes(WEDGED_B), 'GATE 3: alert must include task B');
  });

  it('NEVER touches a completed task (acknowledged_at=NULL) even at cap exhaustion', async () => {
    const WEDGED_ID = 'task-gate3-terminal-wedged';
    const FROZEN_TS = isoMinutesAgo(20);

    function reInsertFrozen(): void {
      exec(`DELETE FROM tasks WHERE external_id = ?`, WEDGED_ID);
      exec(
        `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
         VALUES (?, 'orchestrator', 'Test task', 'in_progress', ?, ?)`,
        WEDGED_ID, isoMinutesAgo(60), FROZEN_TS,
      );
    }

    insertOrchAgent(5);
    reInsertFrozen();
    insertCompletedTask('task-gate3-terminal-completed', 30);

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => 'orch-gate3-terminal-guard',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    for (let run = 1; run < WEDGE_RESTART_CAP; run++) {
      reInsertFrozen();
      exec(`UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
        isoMinutesAgo(5), isoMinutesAgo(5));
      await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });
    }
    reInsertFrozen();
    exec(`UPDATE agents SET last_activity = ?, updated_at = ? WHERE id = 'orchestrator'`,
      isoMinutesAgo(5), isoMinutesAgo(5));
    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    const completedRows = query<{ status: string; acknowledged_at: string | null }>(
      `SELECT status, acknowledged_at FROM tasks WHERE external_id = 'task-gate3-terminal-completed'`,
    );
    assert.equal(completedRows[0]?.status, 'completed',
      'GATE 3: a completed task must remain completed — terminal status is never requeued or failed');
    assert.equal(completedRows[0]?.acknowledged_at, null,
      'GATE 3: acknowledged_at must be untouched (sanity check on the fixture)');
  });
});

// ── signal(iii) regression: bare </ removal false-positive guard ───────────────────────────────

describe('orch-wedge-detector: signal (iii) — bare </ no longer causes false-positive', () => {
  beforeEach(setup);
  afterEach(teardown);

  /**
   * MUTATION-KILL PROOF for the bare </ removal:
   * Revert: add /<\// back to GARBLED_XML_PATTERNS.
   * Expected: this test goes RED (killCalled becomes true on the </em> pane).
   * Restored: test GREEN (no kill on normal closing tag).
   */
  it('does NOT kill when pane contains only normal closing HTML/markdown tags (false-positive guard)', async () => {
    // Pane with closing tags that appear in normal markdown/HTML orch output
    insertOrchAgent(2);  // fresh last_activity — only signal (iii) could fire

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => 'Checking </em>bold</em> or </code>example</code> output\n> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      'Pane with normal HTML closing tags (</em>, </code>) must NOT trigger wedge kill — ' +
      'bare </ was too broad; if </ is re-added to GARBLED_XML_PATTERNS this test goes RED');
  });

  it('STILL kills when pane contains genuine garbled <invoke or <parameter tool XML', async () => {
    insertOrchAgent(2);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '<parameter name="command">ls -la</parameter>\n> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'Pane with garbled <parameter tool XML must still trigger wedge kill');
  });
});

// ── Active-worker exemption (#462) ────────────────────────────────────────────
//
// Signal (ii) — frozen last_activity — must NOT restart the orchestrator when
// active worker_jobs exist. The orch is legitimately waiting for a long-running
// worker; its last_activity is frozen by design during that wait.
//
// Signals (i) and (iii) are NOT exempted by workers.

describe('orch-wedge-detector: signal (ii) active-worker exemption (#462)', () => {
  beforeEach(setup);
  afterEach(teardown);

  /** Insert a worker_job with the given status. */
  function insertWorkerJob(id: string, status: 'running' | 'queued' | 'finished'): void {
    exec(
      `INSERT INTO worker_jobs (id, profile, prompt, status, created_at)
       VALUES (?, 'coding', 'test prompt', ?, ?)`,
      id, status, isoMinutesAgo(30),
    );
  }

  /**
   * Test 1 — #462 repro: orch last_activity frozen >15m, active worker running.
   *
   * MUTATION-KILL PROOF:
   * Revert: remove the active-worker exemption (restore the old `signalII = lastActivity < cutoffIso` line).
   * Expected: killCalled becomes true → test goes RED (restarts orch during live worker wait).
   * Restored: killCalled stays false → test GREEN (exemption suppresses false-positive restart).
   */
  it('does NOT restart orch when last_activity is frozen but an active worker_job is running (#462 repro)', async () => {
    // last_activity frozen 20 min ago (> 15 min threshold) — signal(ii) would fire without the exemption.
    // No in_progress tasks inserted — signal(i) does not fire.
    // Pane is normal — signal(iii) does not fire.
    insertOrchAgent(20);
    // A worker is actively running — the orch is healthy-waiting, not wedged.
    insertWorkerJob('worker-462-1', 'running');

    let killCalled = false;
    const commsMessages: string[] = [];

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-should-not-spawn',
      captureOrchestratorPane: () => '> ',  // normal pane — signal(iii) does not fire
      sendMessage: (msg) => {
        commsMessages.push(msg.body);
        return { messageId: 1, delivered: false };
      },
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      '#462 repro: killOrchestratorSession must NOT be called when last_activity is frozen ' +
      'but an active worker_job is running — the orch is healthy-waiting; ' +
      'reverting the active-worker exemption makes this RED');

    const wedgeRestartAlert = commsMessages.find(b => {
      try { return JSON.parse(b)?.alert === 'orchestrator_wedge_restart'; } catch { return false; }
    });
    assert.equal(wedgeRestartAlert, undefined,
      '#462 repro: orchestrator_wedge_restart alert must NOT be sent when worker is active');
  });

  /**
   * Test 2 — real wedge preserved: last_activity frozen, no active workers → still restarts.
   *
   * MUTATION-KILL PROOF:
   * Revert: make the active-worker exemption unconditional (always suppress signal(ii)).
   * Expected: killCalled stays false → test goes RED (real wedge goes undetected).
   * Restored: killCalled becomes true → test GREEN (no workers = no exemption = real wedge fires).
   */
  it('STILL restarts orch when last_activity is frozen and NO active workers (real wedge)', async () => {
    // last_activity frozen 20 min ago — signal(ii) fires.
    // No running workers — running-worker exemption (#462) does not apply.
    // A finished job does not count as a running worker.
    // A pending task is present — orch is ignoring open work, so idle-queue exemption (#922)
    // does not apply either. This is a real wedge.
    insertOrchAgent(20);
    insertWorkerJob('worker-finished-1', 'finished');
    insertPendingTask('task-real-wedge-pending-1');  // open work the orch is ignoring

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-respawned',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'Real wedge must still fire when last_activity is frozen, no workers are active, and open work exists — ' +
      'making the active-worker exemption unconditional would make this RED');
  });

  /**
   * Test 2b — running-only: last_activity frozen, ONLY a 'queued' job (no 'running') → STILL restarts.
   *
   * Locks the running-only change: a stale 'queued' job must NOT exempt a genuinely-wedged orch.
   * The queued-inflation failure seen 2026-06-17 showed that a stuck 'queued' job that never
   * dispatches would shield a wedged orch indefinitely when the old IN('queued','running') query
   * was used. Only a 'running' job is strong evidence the orch is healthy-waiting.
   *
   * MUTATION-KILL PROOF:
   * Revert: change `status = 'running'` back to `status IN ('queued', 'running')` in
   * context-watchdog.ts signal(ii) query.
   * Expected: killCalled stays false → test goes RED (queued job exempts the wedged orch).
   * Restored: killCalled becomes true → test GREEN (queued job is ignored; wedge fires).
   */
  it('STILL restarts orch when last_activity is frozen and ONLY a queued (not running) worker exists (running-only lock)', async () => {
    // last_activity frozen 20 min ago — signal(ii) should fire.
    // Only a 'queued' job exists — NOT 'running' — so the running-only exemption must NOT apply.
    // A pending task is present so the idle-queue exemption (#922) also does not apply.
    // This is a real wedge: orch ignoring open work with no running workers and no runner.
    insertOrchAgent(20);
    insertWorkerJob('worker-queued-only-1', 'queued');
    insertPendingTask('task-queued-only-pending-1');  // open work the orch is ignoring

    let killCalled = false;
    const commsMessages: string[] = [];

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-queued-only-respawn',
      captureOrchestratorPane: () => '> ',  // normal pane — signal(iii) does not fire
      sendMessage: (msg) => {
        commsMessages.push(msg.body);
        return { messageId: 1, delivered: false };
      },
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'queued-only: killOrchestratorSession MUST be called when last_activity is frozen and ' +
      'only a queued (never-dispatched) worker exists — a queued job is NOT strong evidence ' +
      'the orch is healthy-waiting; reverting to IN(\'queued\',\'running\') makes this RED');

    const wedgeRestartAlert = commsMessages.find(b => {
      try { return JSON.parse(b)?.alert === 'orchestrator_wedge_restart'; } catch { return false; }
    });
    assert.ok(wedgeRestartAlert,
      'queued-only: orchestrator_wedge_restart alert MUST be sent when only a queued job is present');
  });

  /**
   * Test 3 — pane-content trigger unchanged: active workers do NOT suppress signal(iii).
   *
   * MUTATION-KILL PROOF:
   * Revert: extend the active-worker exemption to cover signal(iii) as well.
   * Expected: killCalled stays false → test goes RED (garbled pane goes undetected with active worker).
   * Restored: killCalled becomes true → test GREEN (signal(iii) always fires, workers or not).
   */
  it('STILL restarts orch on pane-content signal (iii) even when active workers are running', async () => {
    // Fresh last_activity — signal(ii) does NOT fire.
    // Active worker running — exemption would apply IF we extended it to signal(iii).
    // Pane shows feedback prompt — signal(iii) fires unconditionally.
    insertOrchAgent(2);  // last_activity 2 min ago — well within 15-min threshold
    insertWorkerJob('worker-pane-test-1', 'running');

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-pane-respawn',
      captureOrchestratorPane: () => 'How is Claude doing this session?\n> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'Pane-content signal (iii) must fire regardless of active workers — ' +
      'garbled pane or feedback prompt is always a real wedge; ' +
      'extending the exemption to cover signal(iii) would make this RED');
  });
});

// ── Signal (i) synthesis-grace exemption (#940) ───────────────
//
// When the orch has a frozen in_progress task BUT a worker recently completed,
// signal(i) must be suppressed — the orch is in its synthesis phase.
// When no worker completed recently (or none at all), signal(i) must STILL fire.

describe('orch-wedge-detector: signal (i) synthesis-grace exemption (#940)', () => {
  beforeEach(setup);
  afterEach(teardown);

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

  /**
   * Case A — mutation-kill: orch in_progress frozen past threshold AND a worker completed
   * within the grace window → signal(i) must be SUPPRESSED (no restart).
   *
   * MUTATION-KILL PROOF:
   * Revert: remove the synthesis-grace exemption (leave signalI = true even when recent completion exists).
   * Expected: killCalled becomes true → test goes RED (restarts orch during synthesis phase).
   * Restored: killCalled stays false → test GREEN (grace window correctly suppresses the restart).
   */
  it('Case A: does NOT restart orch when frozen in_progress task BUT worker completed within grace window', async () => {
    // Orch alive with fresh last_activity (signal(ii) must NOT fire).
    insertOrchAgent(5);
    // in_progress task frozen 20 min ago (> 15 min threshold) — signal(i) would fire without grace.
    insertInProgressTask('task-940-a', 20);
    // Worker completed 5 min ago — within the default 15-min grace window.
    insertCompletedWorkerJob('worker-940-a', 5);

    let killCalled = false;
    const commsMessages: string[] = [];

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-should-not-spawn',
      captureOrchestratorPane: () => '> ',  // normal pane — signal(iii) does not fire
      sendMessage: (msg) => {
        commsMessages.push(msg.body);
        return { messageId: 1, delivered: false };
      },
    });

    await runWatchdog({ wedge_timeout_minutes: 15, synthesis_grace_minutes: 15 });

    assert.equal(killCalled, false,
      '#940 Case A: killOrchestratorSession must NOT be called when in_progress task is frozen ' +
      'but a worker completed within the synthesis grace window — ' +
      'reverting the grace exemption makes this RED (mutation-kill proof)');

    const wedgeAlert = commsMessages.find(b => {
      try { return JSON.parse(b)?.alert === 'orchestrator_wedge_restart'; } catch { return false; }
    });
    assert.equal(wedgeAlert, undefined,
      '#940 Case A: orchestrator_wedge_restart must NOT be sent during synthesis grace window');
  });

  /**
   * Case B — narrowness guard: orch in_progress frozen, NO recent worker completion
   * (last completion older than grace window) → signal(i) must STILL fire (genuine wedge).
   *
   * MUTATION-KILL PROOF:
   * Revert: make the grace exemption unconditional (always suppress signal(i)).
   * Expected: killCalled stays false → test goes RED (real wedge goes undetected).
   * Restored: killCalled becomes true → test GREEN (stale completion = no grace = real wedge fires).
   */
  it('Case B: STILL restarts orch when in_progress frozen and no recent worker completion (genuine wedge)', async () => {
    // Orch alive with fresh last_activity (signal(ii) must NOT fire).
    insertOrchAgent(5);
    // in_progress task frozen 20 min ago (> 15 min threshold).
    insertInProgressTask('task-940-b', 20);
    // Worker completed 30 min ago — OUTSIDE the 15-min grace window — no exemption.
    insertCompletedWorkerJob('worker-940-b-stale', 30);

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-940-b-respawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15, synthesis_grace_minutes: 15 });

    assert.equal(killCalled, true,
      '#940 Case B: killOrchestratorSession MUST be called when in_progress task is frozen ' +
      'and the last worker completion is older than the grace window — ' +
      'making the exemption unconditional would make this RED (narrowness guard)');
  });
});

// ── Signal (ii) facet-b: started_at freshness guard (#922) ────────────────────
//
// R2's exact repro scenario:
//   - Fresh orch: started_at = now (spawned after the cutoff)
//   - agents.last_activity = STALE (inherited from dead predecessor — older than threshold)
//   - PENDING task in queue (non-empty, but not in_progress — signal(i) does not fire)
//   - NO running worker (active-worker exemption does not apply)
//
// Signal(ii) must NOT fire: the orch is only seconds old; the stale last_activity is
// from a dead predecessor, not a genuine wedge.
//
// MUTATION-KILL PROOF:
//   Revert: remove the `if (startedAt !== null && startedAt >= cutoffIso)` guard
//   (e.g. delete the started_at column from the SELECT and the guard block).
//   Expected: killCalled becomes true → test goes RED (fresh orch false-restarted).
//   Restored: killCalled stays false → test GREEN (fresh orch exempted).

describe('orch-wedge-detector: signal (ii) facet-b — started_at freshness guard (#922)', () => {
  beforeEach(setup);
  afterEach(teardown);

  /**
   * Primary mutation-kill test: R2's exact repro.
   *
   * MUTATION-KILL PROOF:
   * Revert: remove the `if (startedAt !== null && startedAt >= cutoffIso)` exemption in
   * context-watchdog.ts signal(ii) (or remove started_at from the SELECT and the guard block).
   * Expected: killCalled becomes true → test goes RED (fresh orch is false-restarted on
   * inherited stale last_activity with a pending task and no running worker).
   * Restored: killCalled stays false → test GREEN (started_at guard exempts fresh orch).
   */
  it('does NOT restart fresh orch when last_activity is stale but started_at is within threshold (#922 repro)', async () => {
    // Fresh orch: started_at = 1 min ago (well within the 15-min threshold).
    // last_activity = 20 min ago (stale — inherited from dead predecessor).
    // This is the exact facet-b scenario: fresh spawn over a dead orch row.
    insertOrchAgent(20, 1);  // last_activity 20 min ago, started_at 1 min ago

    // Pending task in queue — ensures the queue is non-empty (R2's repro had awaiting_plan_approval).
    // Status is 'pending', NOT 'in_progress', so signal(i) does NOT fire.
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
       VALUES ('task-facetb-pending', 'orchestrator', 'Awaiting plan approval', 'pending', ?, ?)`,
      isoMinutesAgo(60),
      isoMinutesAgo(30),
    );

    // No running workers — active-worker exemption (#462) does NOT apply.
    // This isolates the facet-b guard as the sole reason for exemption.

    let killCalled = false;
    const commsMessages: string[] = [];

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-should-not-spawn',
      captureOrchestratorPane: () => '> ',  // normal pane — signal(iii) does not fire
      sendMessage: (msg) => {
        commsMessages.push(msg.body);
        return { messageId: 1, delivered: false };
      },
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      '#922 facet-b: killOrchestratorSession must NOT be called when last_activity is stale ' +
      'but started_at is within the threshold — fresh orch cannot have been frozen for the ' +
      'threshold duration; removing the started_at guard makes this RED (mutation-kill proof)');

    const wedgeAlert = commsMessages.find(b => {
      try { return JSON.parse(b)?.alert === 'orchestrator_wedge_restart'; } catch { return false; }
    });
    assert.equal(wedgeAlert, undefined,
      '#922 facet-b: orchestrator_wedge_restart alert must NOT be sent for a fresh orch');
  });

  /**
   * Narrowness guard: an orch with stale BOTH last_activity AND started_at must still be restarted.
   *
   * Ensures the facet-b guard does not accidentally exempt genuinely-wedged orchs
   * whose started_at pre-dates the cutoff.
   *
   * MUTATION-KILL PROOF:
   * Revert: make the started_at guard unconditional (always suppress signal(ii)).
   * Expected: killCalled stays false → test goes RED (genuine wedge goes undetected).
   * Restored: killCalled becomes true → test GREEN (stale started_at = no exemption = real wedge fires).
   */
  it('STILL restarts orch when both last_activity and started_at are stale (genuine wedge, narrowness guard)', async () => {
    // Old orch: started_at = 60 min ago (well beyond the 15-min threshold).
    // last_activity = 20 min ago (stale — genuine wedge, not inherited stamp).
    // Both fields predate the cutoff → no freshness exemption → signal(ii) must fire.
    insertOrchAgent(20, 60);  // last_activity 20 min ago, started_at 60 min ago

    // A pending task is present so the idle-queue exemption (#922/#475) does NOT apply.
    // Without this the test passes for the wrong reason: the empty-queue exemption
    // suppresses signal(ii) before the started_at guard is ever the deciding factor.
    // With a pending task, all 3 exemptions are traversed and signal(ii) fires correctly.
    insertPendingTask('task-922-narrowness-stale-pending-1');

    // No workers — active-worker exemption (#462) does not apply.

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-922-genuine-respawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdogUntilFires({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      '#922 narrowness: killOrchestratorSession MUST be called when both last_activity and ' +
      'started_at are stale (genuine wedge, not a fresh-spawn scenario) — ' +
      'making the started_at guard unconditional would make this RED');
  });

  /**
   * Near-boundary: orch started_at just inside the threshold (14 min ago with a 15-min threshold)
   * must be treated as fresh and NOT restarted.
   *
   * Ensures that any spawn within the threshold window is correctly exempted, not just
   * extreme near-zero cases. This also validates the >= semantics (14 min ago is clearly
   * inside the window: started_at > cutoffIso because 14-min-ago > 15-min-ago).
   */
  it('exempts orch whose started_at is just inside the threshold window (14 min ago, 15-min threshold)', async () => {
    // started_at 14 min ago — just inside the 15-min threshold (started after cutoff).
    // last_activity 20 min ago — stale (beyond threshold), as if inherited from predecessor.
    insertOrchAgent(20, 14);  // last_activity 20 min ago, started_at 14 min ago

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch-near-boundary-spawn',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, false,
      '#922 near-boundary: orch with started_at 14 min ago (inside 15-min threshold) must NOT be restarted — ' +
      'stale last_activity from a dead predecessor should not false-trigger when orch spawned inside the window');
  });
});
