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
  DEFAULT_WEDGE_TIMEOUT_MINUTES,
} from '../context-watchdog.js';

// ── Helpers ───────────────────────────────────────────────────

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function isoMinutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
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

    await runWatchdog({ wedge_timeout_minutes: 15 });

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

  it('KILLS orchestrator when alive but last_activity frozen beyond threshold', async () => {
    // last_activity 20 min ago, no in_progress tasks, normal pane
    insertOrchAgent(20);
    // No in_progress tasks — signal (i) does not fire; signal (ii) should

    let killCalled = false;

    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      captureOrchestratorPane: () => '> ',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 15 });

    assert.equal(killCalled, true,
      'killOrchestratorSession MUST be called when last_activity is frozen beyond threshold');
  });

  it('respects custom wedge_timeout_minutes config knob', async () => {
    // last_activity 10 min ago — would NOT trigger at default 15 min, but SHOULD at custom 8 min
    insertOrchAgent(10);

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
    await runWatchdog({ wedge_timeout_minutes: 8 });
    assert.equal(killCalled, true, 'MUST fire at 8-min threshold when last_activity is 10 min ago');
  });

  it('DEFAULT_WEDGE_TIMEOUT_MINUTES is 15 (regression guard)', () => {
    assert.equal(DEFAULT_WEDGE_TIMEOUT_MINUTES, 15,
      'Default wedge timeout must be 15 minutes — change this test if you intentionally change the default');
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
