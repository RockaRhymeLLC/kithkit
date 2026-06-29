/**
 * t-222: Context watchdog warns after consecutive missing state files
 *
 * Verifies that the context-watchdog emits a warn log after MISS_WARN_THRESHOLD
 * consecutive misses (file not present), and resets the counter when the file
 * is found successfully.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import { initLogger, _resetLoggerForTesting } from '../core/logger.js';
import { openDatabase, _resetDbForTesting, insert, exec } from '../core/db.js';
import { Scheduler } from '../automation/scheduler.js';
import {
  register as registerContextWatchdog,
  _resetForTesting,
  _setWedgeDepsForTesting,
  _runForTesting,
} from '../automation/tasks/context-watchdog.js';

function makeTmpDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-cw-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
scheduler:
  tasks:
    - name: context-watchdog
      interval: "3m"
      enabled: true
      config:
        requires_session: true
`);
  return tmpDir;
}

/** Read all warn entries from the daemon log in tmpDir. */
function readWarnLogs(logDir: string): Array<{ msg: string; data?: Record<string, unknown> }> {
  const logFile = path.join(logDir, 'daemon.log');
  if (!fs.existsSync(logFile)) return [];
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e): e is { level: string; msg: string; data?: Record<string, unknown> } => e !== null && e.level === 'warn');
}

describe('Context watchdog miss-count warnings (t-222)', () => {
  let tmpDir: string;
  let logDir: string;
  let scheduler: Scheduler;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-cw-logs-'));
    _resetConfigForTesting();
    _resetForTesting();
    // Initialize logger to capture warn output
    initLogger({ logDir, minLevel: 'warn' });
  });

  afterEach(() => {
    if (scheduler?.isRunning()) scheduler.stop();
    _resetConfigForTesting();
    _resetForTesting();
    _resetLoggerForTesting({ logDir: os.tmpdir(), minLevel: 'info' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('does not warn on the first or second consecutive miss', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // Run twice — below threshold (3)
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');

    const warns = readWarnLogs(logDir).filter(e =>
      e.msg.includes('Context usage file missing for comms agent'),
    );
    assert.equal(warns.length, 0, 'Should not warn before threshold is reached');
  });

  it('emits exactly one warn at the third consecutive miss', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // Run 3 times — hits threshold on 3rd
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');

    const warns = readWarnLogs(logDir).filter(e =>
      e.msg.includes('Context usage file missing for comms agent'),
    );
    assert.equal(warns.length, 1, 'Should emit exactly one warn at threshold');
    assert.ok(
      warns[0]!.msg.includes('scripts/context-monitor-statusline.sh'),
      'Warn should mention the statusline script',
    );
  });

  it('does not repeat the warn on 4th and subsequent misses', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // Run 5 times — warn fires only at 3rd
    for (let i = 0; i < 5; i++) {
      await scheduler.triggerTask('context-watchdog');
    }

    const warns = readWarnLogs(logDir).filter(e =>
      e.msg.includes('Context usage file missing for comms agent'),
    );
    assert.equal(warns.length, 1, 'Should still emit only one warn after multiple misses');
  });

  it('resets miss counter after successful read and re-warns after threshold again', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // 3 misses → triggers warning
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');

    // Now create the state file → counter resets
    const stateDir = path.join(tmpDir, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'context-usage.json'),
      JSON.stringify({ used_percentage: 10, remaining_percentage: 90, session_id: 'sess-1' }),
    );

    await scheduler.triggerTask('context-watchdog');

    // Remove the file again → counter resets from 0
    fs.unlinkSync(path.join(stateDir, 'context-usage.json'));

    // 2 more misses — should NOT trigger a second warn (below new threshold)
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');

    const warns = readWarnLogs(logDir).filter(e =>
      e.msg.includes('Context usage file missing for comms agent'),
    );
    assert.equal(warns.length, 1, 'Should only have 1 warn: counter was reset after successful read');
  });

  it('runs successfully on every trigger regardless of miss count', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // Run many times without state file — should never throw
    for (let i = 0; i < 6; i++) {
      const result = await scheduler.triggerTask('context-watchdog');
      assert.equal(result.status, 'success', `Run ${i + 1} should succeed`);
    }
  });
});

// ── Wedge detector: signal(i) running-worker exemption (#462 mirrored into signal(i)) ──────────────────────

/**
 * Tests for the #462 running-worker exemption applied to wedge signal(i).
 *
 * Bug: signal(i) (stale in_progress task MAX(updated_at)) had no active-worker exemption.
 * A worker running >15 min without bumping its parent task's updated_at would trip signal(i)
 * and cause a false restart — looping on every tick.
 *
 * Fix: mirror signal(ii)'s #462 exemption into signal(i): if any worker_jobs row has
 * status='running', signal(i) is suppressed (composes with the existing #940 grace).
 *
 * Tests drive the REAL signal(i) path with REAL worker_jobs rows — no DB mocks.
 * External deps (tmux, sendMessage) are injected via _setWedgeDepsForTesting.
 */
describe('Wedge detector signal(i): #462 running-worker exemption', { concurrency: 1 }, () => {
  let tmpDir: string;
  let restartCalled: boolean;

  /**
   * Seed a stale in_progress orchestrator task.
   * @param updatedAtMsAgo - how many ms in the past to set updated_at
   */
  function seedStaleTask(updatedAtMsAgo: number): void {
    const ts = new Date(Date.now() - updatedAtMsAgo).toISOString();
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Wedge test task', 'in_progress', 'medium', 'human', ?, ?)`,
      'wedge-test-task-ext-462-001', ts, ts,
    );
  }

  /**
   * Seed an orchestrator agent with started_at = NOW.
   * Setting started_at to NOW triggers the FACET-B guard in signal(ii), preventing
   * signal(ii) from firing on these tests (fresh orch cannot have been genuinely frozen).
   */
  function seedFreshOrchAgent(): void {
    const ts = new Date().toISOString();
    insert('agents', {
      id: 'orchestrator',
      type: 'orchestrator',
      status: 'running',
      started_at: ts,
      last_activity: ts,
      updated_at: ts,
    });
  }

  /**
   * Seed a worker_job with the given status and optional finished_at.
   * agent_id is NULL — the FK allows NULL, avoiding a dependency on the agents table.
   */
  function seedWorkerJob(id: string, status: string, finishedAt?: string): void {
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, finished_at, created_at)
       VALUES (?, NULL, 'coding', 'test prompt', ?, ?, ?)`,
      id, status, finishedAt ?? null, new Date().toISOString(),
    );
  }

  // Config: 1-minute wedge threshold, 5-minute synthesis grace window.
  // Tests seed tasks 2 minutes stale — safely beyond the threshold.
  const wedgeConfig = { wedge_timeout_minutes: 1, synthesis_grace_minutes: 5 };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-wedge-462-'));
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
    _resetForTesting();

    restartCalled = false;

    // Mock external deps so we can observe whether a restart was triggered,
    // without touching tmux, sendMessage, or any external system.
    _setWedgeDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => { restartCalled = true; return true; },
      spawnOrchestratorSession: () => null,
      captureOrchestratorPane: () => '',   // empty pane → signal(iii) = false
      sendMessage: () => ({ messageId: 0, delivered: false }),
    });
  });

  afterEach(() => {
    _setWedgeDepsForTesting(null);
    _resetForTesting();
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[MUTATION-KILL] stale in_progress task + running worker → signal(i) does NOT fire (#462)', async () => {
    // MUTATION-KILL PROOF:
    //   Revert: comment out the new `if (signalI)` block for the #462 running-worker exemption
    //   in context-watchdog.ts. With the block absent, signalI stays true when a running
    //   worker is present → restartCalled becomes true → this assertion fails → RED.
    //   With the fix in place: running-worker exemption sets signalI = false → no restart → GREEN.
    //
    // This test drives the REAL signal(i) path using real worker_jobs rows (no DB seams).
    // External deps (kill, spawn, pane, sendMessage) are injected via _setWedgeDepsForTesting.

    seedFreshOrchAgent();
    // Task updated_at = 2 min ago — stale beyond 1-min wedge threshold → signalI candidate
    seedStaleTask(2 * 60_000);
    // Running worker: status='running' mirrors the exact #462 query shape used by signal(ii).
    // COUNT > 0 → exemption must suppress signalI.
    seedWorkerJob('running-worker-mk-001', 'running');

    await _runForTesting(wedgeConfig);

    assert.equal(
      restartCalled, false,
      '[MUTATION-KILL] signal(i) should NOT fire when a running worker is present — orch is ' +
      'healthy-waiting on its worker (#462). MUTATION-KILL: remove the exemption block in ' +
      'monitorOrchestratorWedge() → restartCalled becomes true → RED.',
    );
  });

  it('[#940 COMPOSITION (a)] running worker exempts signal(i)', async () => {
    // Composition test — confirms the new #462 exemption suppresses signal(i).
    // The #462 check uses: SELECT COUNT(*) as count FROM worker_jobs WHERE status = 'running'
    // Only status='running' qualifies; 'queued' does not (per #462 rationale).
    seedFreshOrchAgent();
    seedStaleTask(2 * 60_000);
    seedWorkerJob('running-worker-comp-a', 'running');

    await _runForTesting(wedgeConfig);

    assert.equal(
      restartCalled, false,
      '[#940 composition (a)] Running worker (status=running) must exempt signal(i).',
    );
  });

  it('[#940 COMPOSITION (b)] completed worker within synthesis grace → signal(i) suppressed', async () => {
    // The pre-existing #940 synthesis-grace exemption: when a worker recently completed,
    // the orch is legitimately in its synthesis phase (writing results). signal(i) exempt.
    // No running workers in this case — only a completed worker within the grace window.
    seedFreshOrchAgent();
    seedStaleTask(2 * 60_000);
    // finished_at = 1 minute ago — within the 5-minute synthesis grace window
    const recentFinishedAt = new Date(Date.now() - 60_000).toISOString();
    seedWorkerJob('completed-worker-grace', 'completed', recentFinishedAt);

    await _runForTesting(wedgeConfig);

    assert.equal(
      restartCalled, false,
      '[#940 composition (b)] Worker completed within grace window must suppress signal(i) (#940).',
    );
  });

  it('[NEGATIVE GUARD] stale task + no running worker + outside #940 grace → signal(i) STILL fires', async () => {
    // Verifies the exemption is not over-wide: without a running worker AND without a
    // recently-completed worker, a genuinely-wedged orch must still trigger a restart.
    // Removing the exemption block from the fix does NOT affect this test — it was RED
    // before the fix and must remain GREEN after.
    seedFreshOrchAgent();
    seedStaleTask(2 * 60_000);  // task stale beyond 1-min threshold
    // Completed worker with finished_at OUTSIDE the 5-minute grace window (6 min ago)
    const staleFinishedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    seedWorkerJob('completed-worker-stale', 'completed', staleFinishedAt);
    // No running worker — status='completed' only (does NOT satisfy COUNT WHERE status='running')

    await _runForTesting(wedgeConfig);

    assert.equal(
      restartCalled, true,
      '[NEGATIVE GUARD] signal(i) MUST fire when there is no running worker and no recent ' +
      'completion within grace. The exemption must not over-widen and mask real wedges.',
    );
  });
});
