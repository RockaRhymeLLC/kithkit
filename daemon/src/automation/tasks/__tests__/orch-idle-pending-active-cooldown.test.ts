/**
 * Regression test: Check 0 "pending tasks while Claude is active" nudge (todo #2798).
 *
 * Bug: while the orchestrator was busy (Claude process running) and pending
 * orchestrator tasks existed, this nudge re-fired on every 2-min scheduler tick
 * for the entire busy episode, with no cooldown/anti-spam (unlike
 * message-delivery's busy-ping, which uses a one-shot busy_pinged_at guard) and
 * without checking injectMessage()'s return value (unlike every sibling nudge in
 * this file). Injecting text+C-m into a busy tmux pane is inherently unreliable —
 * verifySubmitLanded()'s "pane content changed" heuristic (tmux.ts) produces false
 * positives while Claude's own output is streaming, masking failed submits. Piling
 * up repeated un-deduped injections left unsubmitted keystrokes in the input line
 * (6 occurrences 7/2-7/4, requiring a manual Enter).
 *
 * Fix: added a 10-minute cooldown (PENDING_ACTIVE_NUDGE_COOLDOWN_MS) gating this
 * nudge to at most once per busy episode, plus a return-value check so failed
 * injects don't start the cooldown (allowing an immediate retry next tick).
 *
 * THIS TEST DRIVES THE REAL GATE via _runForTesting() — the production entry
 * point — with all external I/O mocked through _setDepsForTesting(). It also
 * proves the nudge is delivered exclusively through the shared, mockable
 * injectMessage() seam (tmux.ts's hardened injector) rather than any raw
 * tmux send-keys call.
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
  _resetPendingActiveNudgeStateForTesting,
  _setPendingActiveNudgedAtForTesting,
  _getPendingActiveNudgedAtForTesting,
  _PENDING_ACTIVE_NUDGE_COOLDOWN_MS,
} from '../orchestrator-idle.js';

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

let tmpDir: string;

function setup(): void {
  _resetConfigForTesting();
  _resetDbForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-pending-active-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), 'agent:\n  name: test\n');
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  _resetNudgeStateForTesting();
  _resetPendingActiveNudgeStateForTesting();
  _setJustSpawnedAtForTesting(null); // ensure fast-retry window is closed
}

function teardown(): void {
  setIdleDeps(null);
  _resetNudgeStateForTesting();
  _resetPendingActiveNudgeStateForTesting();
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

/** Insert a pending orchestrator task. */
function insertPendingOrchTask(extId: string): void {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Test task', 'pending', ?, ?)`,
    extId,
    isoMinutesAgo(5),
    isoMinutesAgo(5),
  );
}

describe('orchestrator-idle: Check 0 pending-while-active nudge cooldown (todo #2798)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('injects the pending-tasks nudge via the shared injectMessage seam (not raw send-keys)', async () => {
    insertOrchAgent(2);
    insertPendingOrchTask('task-pending-1');

    const injectedMessages: Array<{ target: string; text: string }> = [];
    setIdleDeps({
      isClaudeProcessRunning: () => true, // busy
      injectMessage: (target, text) => {
        injectedMessages.push({ target, text });
        return true;
      },
    });

    await runIdleMonitor({ idle_timeout_minutes: 10 });

    assert.equal(injectedMessages.length, 1, 'expected exactly one nudge via the mockable injectMessage seam');
    assert.equal(injectedMessages[0]!.target, 'orchestrator');
    assert.match(injectedMessages[0]!.text, /1 pending task\(s\) in queue/);
  });

  it('does NOT re-fire on the very next tick while still within the cooldown (core regression)', async () => {
    insertOrchAgent(2);
    insertPendingOrchTask('task-pending-1');

    const injectedMessages: Array<{ target: string; text: string }> = [];
    setIdleDeps({
      isClaudeProcessRunning: () => true,
      injectMessage: (target, text) => {
        injectedMessages.push({ target, text });
        return true;
      },
    });

    await runIdleMonitor({ idle_timeout_minutes: 10 }); // tick 1 — nudges
    await runIdleMonitor({ idle_timeout_minutes: 10 }); // tick 2 — same busy+pending state, immediately after

    assert.equal(
      injectedMessages.length,
      1,
      'a second immediate tick under the same busy+pending conditions must NOT re-inject (cooldown regression)',
    );
  });

  it('re-fires once the cooldown window has elapsed', async () => {
    insertOrchAgent(2);
    insertPendingOrchTask('task-pending-1');

    const injectedMessages: Array<{ target: string; text: string }> = [];
    setIdleDeps({
      isClaudeProcessRunning: () => true,
      injectMessage: (target, text) => {
        injectedMessages.push({ target, text });
        return true;
      },
    });

    await runIdleMonitor({ idle_timeout_minutes: 10 }); // tick 1 — nudges, sets cooldown
    assert.equal(injectedMessages.length, 1);

    // Simulate the cooldown having fully elapsed.
    _setPendingActiveNudgedAtForTesting(Date.now() - (_PENDING_ACTIVE_NUDGE_COOLDOWN_MS + 1000));

    await runIdleMonitor({ idle_timeout_minutes: 10 }); // tick 2 — cooldown expired, nudges again

    assert.equal(injectedMessages.length, 2, 'should re-fire once the cooldown window has passed');
  });

  it('does not start the cooldown when injectMessage reports the submit was not verified', async () => {
    insertOrchAgent(2);
    insertPendingOrchTask('task-pending-1');

    const injectedMessages: Array<{ target: string; text: string }> = [];
    setIdleDeps({
      isClaudeProcessRunning: () => true,
      injectMessage: (target, text) => {
        injectedMessages.push({ target, text });
        return false; // simulate an unverified/failed submit
      },
    });

    await runIdleMonitor({ idle_timeout_minutes: 10 }); // tick 1 — attempts, fails to verify
    assert.equal(injectedMessages.length, 1);
    assert.equal(
      _getPendingActiveNudgedAtForTesting(),
      null,
      'cooldown must NOT be set when the inject was not verified as submitted',
    );

    await runIdleMonitor({ idle_timeout_minutes: 10 }); // tick 2 — should retry immediately, no cooldown blocking it

    assert.equal(injectedMessages.length, 2, 'a failed/unverified inject should be retried on the next tick, not throttled');
  });

  it('resets the cooldown once the pending queue is drained', async () => {
    insertOrchAgent(2);
    insertPendingOrchTask('task-pending-1');

    const injectedMessages: Array<{ target: string; text: string }> = [];
    setIdleDeps({
      isClaudeProcessRunning: () => true,
      injectMessage: (target, text) => {
        injectedMessages.push({ target, text });
        return true;
      },
    });

    await runIdleMonitor({ idle_timeout_minutes: 10 }); // tick 1 — nudges, sets cooldown
    assert.equal(injectedMessages.length, 1);
    assert.notEqual(_getPendingActiveNudgedAtForTesting(), null);

    // Drain the queue.
    exec(`UPDATE tasks SET status = 'assigned' WHERE external_id = 'task-pending-1'`);

    await runIdleMonitor({ idle_timeout_minutes: 10 }); // tick 2 — no pending tasks, cooldown resets

    assert.equal(
      _getPendingActiveNudgedAtForTesting(),
      null,
      'cooldown state should reset once there are no pending tasks left',
    );
  });
});
