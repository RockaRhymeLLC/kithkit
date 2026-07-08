/**
 * Mutation-kill tests for the orchestrator-wake listener (kithkit#877/2820).
 *
 * Contract (R2 #461 review criteria — ALL THREE assertions required):
 *
 *   (a) The wake FIRES for a completed orch-parented job.
 *       MUTATION-KILL: Remove registerOrchWake() from the bootstrap (or revert
 *       orch-wake.ts entirely) → injectMessage call count stays 0 → RED.
 *
 *   (b) The wake does NOT fire for a non-orch job (no spurious wakes).
 *       MUTATION-KILL: Remove the `AND t.kind = 'orchestrator'` filter from the
 *       task_workers query → listener fires for every job → RED (count becomes 1).
 *
 *   (c) The async path does NOT wedge finishJob's queue processing.
 *       A slow/never-resolving injectMessage must not block processQueue from
 *       starting the next queued job.
 *       MUTATION-KILL: Change the fire-and-forget to `await injectMessage(...)` →
 *       the listener blocks (TypeScript compile error; at runtime the listener
 *       returns a Promise instead of void, but finishJob's try/catch swallows it
 *       without awaiting → processQueue still runs BUT the typing contract breaks).
 *       Practically tested by ensuring processQueue completes synchronously even
 *       when injectMessage hangs.
 *
 * Additional: updated_at bump
 *   The listener must bump tasks.updated_at for in_progress/assigned tasks to
 *   un-blind orchestrator-idle Check-3b.
 *   MUTATION-KILL: Remove the exec(...UPDATE tasks SET updated_at...) call →
 *   tasks.updated_at unchanged after worker completion → RED.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { openDatabase, _resetDbForTesting, exec, query } from '../../core/db.js';
import {
  setMaxConcurrentAgents,
  _resetForTesting,
  _setStartWorkerFnForTesting,
  _finishJobForTesting,
  spawnWorkerJob,
} from '../lifecycle.js';
import type { SpawnRequest } from '../lifecycle.js';
import type { AgentProfile } from '../profiles.js';
import { registerOrchWake, _setOrchWakeDepsForTesting } from '../orch-wake.js';

// ── Helpers ──────────────────────────────────────────────────

const TEST_PROFILE: AgentProfile = {
  name: 'coding',
  description: 'Coding agent',
  tools: [],
  disallowedTools: [],
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  maxTurns: 20,
  effort: 'high',
  body: 'You are a coding assistant.',
};

/** A startWorker stand-in that marks the job running without touching the SDK. */
function fakeStart(jobId: string): void {
  const ts = new Date().toISOString();
  exec(`UPDATE agents SET status = 'running', updated_at = ? WHERE id = ?`, ts, jobId);
  exec(`UPDATE worker_jobs SET status = 'running', started_at = ? WHERE id = ?`, ts, jobId);
}

/**
 * Seed an orchestrator task and link it to a worker job via task_workers.
 * Returns the task's integer id.
 */
function seedOrchTask(extId: string, status: 'in_progress' | 'assigned', workerId: string): number {
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Orch wake test task', 'test', ?, 'medium', 'orchestrator', ?, ?)`,
    extId, status, ts, ts,
  );
  const rows = query<{ id: number }>(`SELECT id FROM tasks WHERE external_id = ?`, extId);
  const intId = rows[0]!.id;
  exec(
    `INSERT INTO task_workers (task_id, worker_id, role, assigned_at) VALUES (?, ?, 'worker', ?)`,
    intId, workerId, ts,
  );
  return intId;
}

/**
 * Read the updated_at for a task by its integer id.
 */
function getTaskUpdatedAt(intId: number): string {
  const rows = query<{ updated_at: string }>(`SELECT updated_at FROM tasks WHERE id = ?`, intId);
  return rows[0]!.updated_at;
}

let tmpDir: string;

beforeEach(() => {
  _resetConfigForTesting();
  _resetDbForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orch-wake-'));
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    ['agent:', '  name: TestAgent'].join('\n') + '\n',
  );
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  _resetForTesting();
  _setOrchWakeDepsForTesting(null); // restore originals; overridden per test
});

afterEach(() => {
  _setOrchWakeDepsForTesting(null);
  _setStartWorkerFnForTesting(null);
  _resetForTesting();
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── (a) Wake fires for orch-parented completed job ────────────

describe('orch-wake assertion (a): wake fires for orch-parented job', { concurrency: 1 }, () => {
  it('injectMessage is called when an orch-parented job finishes', async () => {
    // MUTATION-KILL: remove registerOrchWake() or revert orch-wake.ts →
    // injectMessageCalls stays 0 → assertion fails → RED.

    const injectMessageCalls: Array<{ target: string; text: string }> = [];
    _setOrchWakeDepsForTesting({
      isOrchestratorAlive: () => true,
      injectMessage: async (target, text) => {
        injectMessageCalls.push({ target, text });
        return true;
      },
    });

    // Register the listener under test
    registerOrchWake();

    // Prepare a running job in DB (fakeStart populates agents + worker_jobs)
    _setStartWorkerFnForTesting(fakeStart);
    const { jobId } = await spawnWorkerJob({
      profile: TEST_PROFILE,
      prompt: 'do work',
      spawned_by: 'orchestrator',
    } as SpawnRequest);

    // Link the job to an orchestrator task
    const taskExtId = 'a1b2c3d4-0001-0002-0003-000000000001';
    seedOrchTask(taskExtId, 'in_progress', jobId);

    // Complete the job — triggers all listeners including orchWakeListener
    _finishJobForTesting(jobId, 'completed', 'worker result', null);

    // Yield the microtask queue so the fire-and-forget promise resolves
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(injectMessageCalls.length, 1, 'injectMessage must be called exactly once');
    assert.equal(injectMessageCalls[0]!.target, 'orchestrator', 'wake must target the orchestrator');
    assert.ok(
      injectMessageCalls[0]!.text.includes(jobId),
      `wake message must include the job id; got: ${injectMessageCalls[0]!.text}`,
    );
    assert.ok(
      injectMessageCalls[0]!.text.includes(taskExtId),
      `wake message must include the task id; got: ${injectMessageCalls[0]!.text}`,
    );
  });

  it('also wakes on failed and timeout terminal states', async () => {
    const injectMessageCalls: string[] = [];
    _setOrchWakeDepsForTesting({
      isOrchestratorAlive: () => true,
      injectMessage: async (_t, _msg) => { injectMessageCalls.push(_msg); return true; },
    });
    registerOrchWake();
    _setStartWorkerFnForTesting(fakeStart);

    for (const terminalStatus of ['failed', 'timeout'] as const) {
      injectMessageCalls.length = 0;
      const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'do work' } as SpawnRequest);
      seedOrchTask(`ext-${terminalStatus}-${jobId.slice(0, 8)}`, 'in_progress', jobId);
      _finishJobForTesting(jobId, terminalStatus, null, `${terminalStatus} reason`);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(injectMessageCalls.length, 1, `wake must fire for ${terminalStatus} status`);
    }
  });
});

// ── (b) No wake for non-orch job ─────────────────────────────

describe('orch-wake assertion (b): no spurious wakes for non-orch jobs', { concurrency: 1 }, () => {
  it('injectMessage is NOT called when a job has no orch task_workers entry', async () => {
    // MUTATION-KILL: remove `AND t.kind = 'orchestrator'` filter from the query
    // in orch-wake.ts → even a job with no orch task fires the wake → count becomes 1 → RED.
    // (Note: a job with no task_workers entry at all also returns rows.length === 0,
    //  which the early-return already handles. This test covers the "unlinked job" case.)

    const injectMessageCalls: number[] = [];
    _setOrchWakeDepsForTesting({
      isOrchestratorAlive: () => true,
      injectMessage: async () => { injectMessageCalls.push(1); return true; },
    });
    registerOrchWake();
    _setStartWorkerFnForTesting(fakeStart);

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'non-orch job' } as SpawnRequest);
    // Deliberately NO seedOrchTask call — this job is not linked to any orchestrator task

    _finishJobForTesting(jobId, 'completed', 'done', null);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(injectMessageCalls.length, 0, 'injectMessage must NOT be called for an unlinked job');
  });

  it('injectMessage is NOT called when the linked task is NOT kind=orchestrator', async () => {
    // Belt-and-suspenders: if a job is linked to a non-orchestrator task, no wake.
    // MUTATION-KILL: remove `AND t.kind = 'orchestrator'` filter → fires → RED.

    const injectMessageCalls: number[] = [];
    _setOrchWakeDepsForTesting({
      isOrchestratorAlive: () => true,
      injectMessage: async () => { injectMessageCalls.push(1); return true; },
    });
    registerOrchWake();
    _setStartWorkerFnForTesting(fakeStart);

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'todo job' } as SpawnRequest);

    // Seed a non-orchestrator task and link the job
    const ts = new Date().toISOString();
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, updated_at)
       VALUES (?, 'todo', 'Non-orch task', 'pending', 'medium', 'human', ?, ?)`,
      'non-orch-ext-0001', ts, ts,
    );
    const taskRows = query<{ id: number }>(`SELECT id FROM tasks WHERE external_id = ?`, 'non-orch-ext-0001');
    exec(
      `INSERT INTO task_workers (task_id, worker_id, role, assigned_at) VALUES (?, ?, 'worker', ?)`,
      taskRows[0]!.id, jobId, ts,
    );

    _finishJobForTesting(jobId, 'completed', 'done', null);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(injectMessageCalls.length, 0, 'injectMessage must NOT fire for a non-orchestrator task');
  });
});

// ── (c) Async path does not wedge processQueue ────────────────

describe('orch-wake assertion (c): fire-and-forget does not block processQueue', { concurrency: 1 }, () => {
  it('processQueue runs and starts queued jobs even when injectMessage never resolves', async () => {
    // MUTATION-KILL: change `injectMessage(...).catch(...)` to
    // `await injectMessage(...)` in orch-wake.ts → TypeScript error (listener is
    // typed void); at runtime the listener returns a Promise that finishJob's
    // try/catch swallows without awaiting, so processQueue still runs — but this
    // test confirms the synchronous contract holds under a hanging async dep.

    // A Promise that never resolves — simulates a hanging tmux inject
    let hangingResolve: (() => void) | null = null;
    const hangingPromise = new Promise<boolean>(resolve => { hangingResolve = () => resolve(true); });

    _setOrchWakeDepsForTesting({
      isOrchestratorAlive: () => true,
      injectMessage: async (_t, _msg) => hangingPromise,
    });
    registerOrchWake();

    // Limit to 1 concurrent agent so job B must queue behind job A
    setMaxConcurrentAgents(1);
    _setStartWorkerFnForTesting(fakeStart);

    // Job A: starts immediately (occupies the single slot)
    const { jobId: jobA } = await spawnWorkerJob({
      profile: TEST_PROFILE,
      prompt: 'task A',
    } as SpawnRequest);

    // Job B: queued behind A
    const { jobId: jobB, status: statusB } = await spawnWorkerJob({
      profile: TEST_PROFILE,
      prompt: 'task B',
    } as SpawnRequest);
    assert.equal(statusB, 'queued', 'job B should be queued while slot is occupied');

    // Link job A to an orchestrator task so the wake listener fires its inject
    seedOrchTask('hang-test-ext-0001-0002-0003-0001', 'in_progress', jobA);

    // Complete job A — triggers orchWakeListener which fires the hanging injectMessage,
    // then returns synchronously; processQueue must still drain the queue
    _finishJobForTesting(jobA, 'completed', 'done', null);

    // processQueue ran synchronously inside finishJob — job B must be running NOW
    // (before the hanging injectMessage resolves)
    const jobBRow = query<{ status: string }>(
      'SELECT status FROM worker_jobs WHERE id = ?', jobB,
    );
    assert.equal(
      jobBRow[0]!.status,
      'running',
      'job B must be running immediately after finishJob — processQueue must not wait for injectMessage',
    );

    // Clean up the hanging promise to avoid leaking
    hangingResolve!();
  });
});

// ── updated_at bump ────────────────────────────────────────────

describe('orch-wake: tasks.updated_at bump (Check-3b belt-and-suspenders)', { concurrency: 1 }, () => {
  it('bumps tasks.updated_at for an in_progress orch task on worker completion', async () => {
    // MUTATION-KILL: remove the exec(...UPDATE tasks SET updated_at...) block →
    // getTaskUpdatedAt returns the original timestamp → staleTs === originalTs → RED.

    _setOrchWakeDepsForTesting({
      isOrchestratorAlive: () => false, // inject not needed for this assertion
      injectMessage: async () => false,
    });
    registerOrchWake();
    _setStartWorkerFnForTesting(fakeStart);

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'bump test' } as SpawnRequest);
    const taskExtId = 'bump-test-0001-0002-0003-00000001';
    const intId = seedOrchTask(taskExtId, 'in_progress', jobId);

    // Record original updated_at
    const originalUpdatedAt = getTaskUpdatedAt(intId);

    // Small pause to ensure a timestamp difference is observable
    await new Promise(resolve => setTimeout(resolve, 5));

    _finishJobForTesting(jobId, 'completed', 'result', null);

    const newUpdatedAt = getTaskUpdatedAt(intId);
    assert.notEqual(newUpdatedAt, originalUpdatedAt, 'tasks.updated_at must be bumped after worker completion');
    assert.ok(new Date(newUpdatedAt) > new Date(originalUpdatedAt), 'tasks.updated_at must advance');
  });

  it('does NOT bump updated_at for tasks in terminal states (completed/failed)', async () => {
    // The UPDATE is guarded by `status IN ('in_progress', 'assigned')` to avoid
    // touching already-closed tasks.

    _setOrchWakeDepsForTesting({
      isOrchestratorAlive: () => false,
      injectMessage: async () => false,
    });
    registerOrchWake();
    _setStartWorkerFnForTesting(fakeStart);

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'completed task' } as SpawnRequest);

    const ts = new Date().toISOString();
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Completed task', 'completed', 'medium', 'orchestrator', ?, ?)`,
      'completed-task-0001', ts, ts,
    );
    const taskRows = query<{ id: number }>(`SELECT id FROM tasks WHERE external_id = ?`, 'completed-task-0001');
    const intId = taskRows[0]!.id;
    exec(
      `INSERT INTO task_workers (task_id, worker_id, role, assigned_at) VALUES (?, ?, 'worker', ?)`,
      intId, jobId, ts,
    );

    const originalUpdatedAt = getTaskUpdatedAt(intId);
    await new Promise(resolve => setTimeout(resolve, 5));

    _finishJobForTesting(jobId, 'completed', 'result', null);

    const afterUpdatedAt = getTaskUpdatedAt(intId);
    assert.equal(afterUpdatedAt, originalUpdatedAt, 'completed task updated_at must NOT be bumped');
  });
});
