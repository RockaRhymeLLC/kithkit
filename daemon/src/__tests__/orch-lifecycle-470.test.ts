/**
 * Regression tests for #470: orchestrator task lifecycle fixes.
 *
 * Covers the three contract items NOT already covered by unified-tasks-lifecycle.test.ts:
 *
 *   CONTRACT 1 — Shim endpoint (PUT /api/orchestrator/tasks/:id via handleTaskQueueRoute)
 *     failed→completed and failed→cancelled return 200.
 *     MUTATION-KILL: revert shim VALID_TRANSITIONS.failed escape-valve → 409.
 *
 *   CONTRACT 2 — Orphan sweeper (cleanupOrphanedTasks in orchestrator-idle.ts)
 *     (a) Task with recent updated_at is NOT failed.
 *     (b) Task with a completed worker_job is RESET to 'assigned', not failed.
 *     (c) Truly orphaned stale task (old updated_at, no completed worker) IS failed.
 *     MUTATION-KILL: revert each exemption → task wrongly failed.
 *
 *   CONTRACT 3 — Spawn retry (POST /api/orchestrator/escalate via handleOrchestratorRoute)
 *     spawnOrchestratorSession is called up to 3 times before permanently failing.
 *     MUTATION-KILL: revert retry loop (single attempt) → task failed after 1 miss.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec, query } from '../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import { handleTaskQueueRoute } from '../api/task-queue.js';
import {
  handleOrchestratorRoute,
  _setDepsForTesting as _setOrchDepsForTesting,
} from '../api/orchestrator.js';
import {
  _runForTesting as _runOrchIdle,
  _setDepsForTesting as _setIdleDepsForTesting,
  _resetNudgeStateForTesting,
  _ORPHAN_RECENT_ACTIVITY_MS,
} from '../automation/tasks/orchestrator-idle.js';
import { insert } from '../core/db.js';

// ── Port assignments (unused by other test files) ─────────────────────────────

const PORT_SHIM = 19883;
const PORT_SPAWN_RETRY = 19885;

// ── HTTP request helper ────────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
        ...(headers ?? {}),
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ── DB + server harness helpers ────────────────────────────────────────────────

function setupDb(tmpDir: string): void {
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function makeServer(
  port: number,
  handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>,
): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      handler(req, res, url)
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
        })
        .catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server?.listening) server.close(() => resolve());
    else resolve();
  });
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Seed a task directly in the DB at a given status (bypasses state machine).
 * Returns the external_id.
 */
function seedShimTask(extId: string, status: string): void {
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Shim escape-valve test', 'test', ?, 'medium', 'orchestrator', ?, ?)`,
    extId, status, ts, ts,
  );
}

/**
 * Seed an orchestrator task for orphan-sweeper tests.
 * updated_at is set to `updatedAt` (ISO string).
 * started_at is set to `startedAt` (ISO string) — determines COALESCE in sweep query.
 */
function seedOrphanTask(
  extId: string,
  status: 'in_progress' | 'assigned',
  startedAt: string,
  updatedAt: string,
): number {
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, priority, source, started_at, assigned_at, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Orphan test task', ?, 'medium', 'orchestrator', ?, ?, ?, ?)`,
    extId, status, startedAt, startedAt, startedAt, updatedAt,
  );
  const rows = query<{ id: number }>(`SELECT id FROM tasks WHERE external_id = ?`, extId);
  return rows[0]!.id;
}

/**
 * Seed a worker_job and link it to a task via task_workers.
 * worker_id is the job id (task_workers.worker_id = worker_jobs.id per lifecycle convention).
 * agent_id is set to NULL (the FK allows it, avoiding a dependency on the agents table).
 */
function seedCompletedWorker(taskIntId: number, workerId: string): void {
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
     VALUES (?, NULL, 'coding', 'test prompt', 'completed', ?)`,
    workerId, ts,
  );
  exec(
    `INSERT INTO task_workers (task_id, worker_id, role, assigned_at) VALUES (?, ?, 'worker', ?)`,
    taskIntId, workerId, ts,
  );
}

// ── CONTRACT 1: Shim endpoint escape-valve ─────────────────────────────────────

describe('#470 escape-valve via PUT /api/orchestrator/tasks/:id (shim — task-queue.ts)', { concurrency: 1 }, () => {
  let server: http.Server;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-shim-470-'));
    setupDb(tmpDir);
    server = await makeServer(PORT_SHIM, (req, res, url) =>
      handleTaskQueueRoute(req, res, url.pathname, url.searchParams),
    );
  });

  afterEach(async () => {
    _resetDbForTesting();
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shim: failed → completed returns 200 (#470 escape-valve on shim endpoint)', async () => {
    // MUTATION-KILL: revert VALID_TRANSITIONS.failed escape-valve in task-queue.ts
    // (change failed:['pending','completed','cancelled'] back to ['pending']) →
    // the transition guard returns 409 "cannot transition from failed to completed" → RED.
    const extId = 'shim-esc-0001-0002-0003-000000000001';
    seedShimTask(extId, 'failed');

    const res = await request(PORT_SHIM, 'PUT', `/api/orchestrator/tasks/${extId}`, {
      status: 'completed',
      result: 'work succeeded; orch restarted before synthesis (shim path)',
    });
    assert.equal(
      res.status, 200,
      `Shim: expected 200 for failed→completed, got ${res.status}: ${res.body}`,
    );
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(body.status, 'completed', 'task status should be completed');
  });

  it('shim: failed → cancelled returns 200 (#470 escape-valve on shim endpoint)', async () => {
    // MUTATION-KILL: revert failed→cancelled from shim VALID_TRANSITIONS → 409 → RED.
    const extId = 'shim-esc-0001-0002-0003-000000000002';
    seedShimTask(extId, 'failed');

    const res = await request(PORT_SHIM, 'PUT', `/api/orchestrator/tasks/${extId}`, {
      status: 'cancelled',
    });
    assert.equal(
      res.status, 200,
      `Shim: expected 200 for failed→cancelled, got ${res.status}: ${res.body}`,
    );
    assert.equal(JSON.parse(res.body).status, 'cancelled');
  });

  it('shim: terminal-block still applies to non-escape-valve transitions on failed tasks', async () => {
    // Confirm isFailedEscapeValve does NOT widen the gate beyond pending/completed/cancelled.
    // This is a safety/guard test — it should stay green with or without the fix.
    const extId = 'shim-esc-0001-0002-0003-000000000003';
    seedShimTask(extId, 'failed');

    const res = await request(PORT_SHIM, 'PUT', `/api/orchestrator/tasks/${extId}`, {
      status: 'in_progress',   // NOT in failed's escape-valve list
    });
    assert.equal(
      res.status, 409,
      `Shim: failed→in_progress must remain blocked (409), got ${res.status}`,
    );
  });
});

// ── CONTRACT 2: Orphan sweeper ────────────────────────────────────────────────

describe('#470 orphan sweeper cleanupOrphanedTasks in orchestrator-idle.ts', { concurrency: 1 }, () => {
  let tmpDir: string;

  function setupOrphanEnv(orchStartedOffset: number): void {
    // orchStartedOffset: ms AFTER the old tasks started. Positive = orch is newer than tasks.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-orphan-470-'));
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

    // Seed the orchestrator agent row — started_at is AFTER the task timestamps
    // so the tasks appear to belong to a previous orchestrator instance.
    const orchStartedAt = new Date(Date.now() + orchStartedOffset).toISOString();
    insert('agents', {
      id: 'orchestrator',
      type: 'orchestrator',
      status: 'running',
      started_at: orchStartedAt,
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  afterEach(() => {
    _setIdleDepsForTesting(null);
    _resetNudgeStateForTesting();
    _resetDbForTesting();
    _resetConfigForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) task with recent updated_at is NOT failed by sweeper (#470 recent-activity exemption)', async () => {
    // MUTATION-KILL: remove the "if (task.updated_at >= recentCutoff) continue" guard from
    // cleanupOrphanedTasks → this recently-active task gets swept and its status becomes
    // 'failed', causing the assertion below to fail → RED.
    setupOrphanEnv(1000);  // orch started 1s after tasks

    const oldStarted = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    const recentUpdated = new Date(Date.now() - 60_000).toISOString();    // 1 min ago (within 5min window)
    const extId = 'orphan-recent-0001-0002-000000000001';
    seedOrphanTask(extId, 'in_progress', oldStarted, recentUpdated);

    _setIdleDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      cleanupSessionDirs: () => 0,
      isClaudeProcessRunning: () => false,
    });

    await _runOrchIdle({});

    const rows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = ?`, extId);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.status, 'in_progress',
      `Recently-active task should remain in_progress (not swept), but got: ${rows[0]!.status}. ` +
      `ORPHAN_RECENT_ACTIVITY_MS=${_ORPHAN_RECENT_ACTIVITY_MS}ms`,
    );
  });

  it('(b) task with completed worker_job is RESET to assigned, not failed (#470 completed-worker exemption)', async () => {
    // MUTATION-KILL: remove the completedWorkers check from cleanupOrphanedTasks
    // → task is swept to 'failed' instead of reset to 'assigned' → RED.
    setupOrphanEnv(1000);

    // Task timestamps: old enough to be a candidate AND old enough to NOT be "recently active"
    const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
    const extId = 'orphan-compw-0001-0002-000000000001';
    const taskIntId = seedOrphanTask(extId, 'in_progress', oldTime, oldTime);

    // Seed a completed worker_job linked to this task.
    // The JOIN is: task_workers tw JOIN worker_jobs wj ON tw.worker_id = wj.id WHERE wj.status='completed'
    // task_workers.worker_id = worker_jobs.id (the jobId convention from lifecycle.ts:228).
    seedCompletedWorker(taskIntId, 'worker-job-completed-0001');

    _setIdleDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      cleanupSessionDirs: () => 0,
      isClaudeProcessRunning: () => false,
    });

    await _runOrchIdle({});

    const rows = query<{ status: string }>(`SELECT status FROM tasks WHERE external_id = ?`, extId);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.status, 'assigned',
      `Task with completed worker should be reset to 'assigned' (not failed), got: ${rows[0]!.status}`,
    );
  });

  it('(c) truly orphaned stale task IS failed by sweeper (baseline — no exemption applies)', async () => {
    // Verifies the sweeper still marks genuinely-orphaned tasks failed.
    // MUTATION-KILL: if the sweeper were removed entirely, this test would fail because
    // the task stays 'in_progress' instead of being swept to 'failed' → RED.
    setupOrphanEnv(1000);

    // Old timestamps — outside the recent-activity window, no completed worker
    const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
    const extId = 'orphan-truly-0001-0002-000000000001';
    seedOrphanTask(extId, 'in_progress', oldTime, oldTime);

    _setIdleDepsForTesting({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      cleanupSessionDirs: () => 0,
      isClaudeProcessRunning: () => false,
    });

    await _runOrchIdle({});

    const rows = query<{ status: string; error: string | null }>(`SELECT status, error FROM tasks WHERE external_id = ?`, extId);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.status, 'failed',
      `Truly-orphaned task should be swept to 'failed', got: ${rows[0]!.status}`,
    );
    assert.equal(
      rows[0]!.error, 'orchestrator_restarted',
      `Swept task error should be 'orchestrator_restarted', got: ${rows[0]!.error}`,
    );
  });
});

// ── CONTRACT 3: Spawn retry ────────────────────────────────────────────────────

describe('#470 spawn-null retry (POST /api/orchestrator/escalate)', { concurrency: 1 }, () => {
  let server: http.Server;
  let tmpDir: string;
  let logDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-spawn-retry-470-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-spawn-retry-log-470-'));
    fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
daemon:
  port: ${PORT_SPAWN_RETRY}
  log_dir: ${logDir}
scheduler:
  tasks: []
`);
    _resetConfigForTesting();
    loadConfig(tmpDir);
    setupDb(tmpDir);

    server = await makeServer(PORT_SPAWN_RETRY, (req, res, url) =>
      handleOrchestratorRoute(req, res, url.pathname),
    );
  });

  afterEach(async () => {
    _setOrchDepsForTesting(null);
    _resetDbForTesting();
    _resetConfigForTesting();
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('spawn is retried up to 3 times before the task is failed (#470 bounded retry)', async () => {
    // MUTATION-KILL: change the retry loop to attempt=1 only (no retry) →
    // spawnCallCount will be 1, not 3, causing the assertion below to fail → RED.
    //
    // The test uses _setDepsForTesting to inject a spawn that always returns null,
    // then verifies: (a) the task is failed after exhaustion, and (b) the spawn
    // was attempted SPAWN_MAX_ATTEMPTS (3) times.
    let spawnCallCount = 0;

    _setOrchDepsForTesting({
      getOrchestratorState: () => 'dead',           // force the spawn path
      spawnOrchestratorSession: () => {
        spawnCallCount++;
        return null;                                 // always fail to simulate transient failure
      },
      sendMessage: () => ({ messageId: 0, delivered: false }),
      injectMessage: () => false,
    });

    const res = await request(PORT_SPAWN_RETRY, 'POST', '/api/orchestrator/escalate', {
      task: 'Retry test task — spawn always null',
    });

    // After all retries exhausted, should return 500
    assert.equal(
      res.status, 500,
      `Expected 500 after spawn exhaustion, got ${res.status}: ${res.body}`,
    );

    // Confirm 3 spawn attempts were made (SPAWN_MAX_ATTEMPTS = 3)
    assert.equal(
      spawnCallCount, 3,
      `Expected 3 spawn attempts (SPAWN_MAX_ATTEMPTS), got ${spawnCallCount}. ` +
      `MUTATION-KILL: removing retry loop → spawnCallCount=1 → this assertion fails → RED`,
    );

    // Confirm the task was marked failed in DB
    const rows = query<{ status: string; error: string | null }>(
      `SELECT status, error FROM tasks WHERE kind = 'orchestrator' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(rows.length, 1, 'task row should exist in DB');
    assert.equal(rows[0]!.status, 'failed', `task should be failed after spawn exhaustion, got: ${rows[0]!.status}`);
    assert.ok(
      (rows[0]!.error ?? '').includes('Failed to spawn'),
      `task error should mention spawn failure, got: ${rows[0]!.error}`,
    );
  });

  it('spawn succeeds on 2nd attempt — task remains pending (not failed)', async () => {
    // Verifies that a single transient failure does not permanently fail the task.
    // MUTATION-KILL: remove the retry loop → spawnCallCount=1, but since the first call
    // would fail and there's no retry, the task would be permanently failed.
    // With the retry, the second attempt succeeds → task stays pending → assertion passes.
    //
    // Note: in the retry scenario, when spawn succeeds the task stays 'pending'
    // (not 'failed') — it gets transitioned by the orchestrator lifecycle as normal.
    let spawnCallCount = 0;
    _setOrchDepsForTesting({
      getOrchestratorState: () => 'dead',
      spawnOrchestratorSession: () => {
        spawnCallCount++;
        if (spawnCallCount === 1) return null;   // 1st attempt fails (transient)
        return 'orch-session-retry-success';      // 2nd attempt succeeds
      },
      sendMessage: () => ({ messageId: 0, delivered: false }),
      injectMessage: () => false,
    });

    const res = await request(PORT_SPAWN_RETRY, 'POST', '/api/orchestrator/escalate', {
      task: 'Retry test — succeeds on 2nd attempt',
    });

    // Should return 202 (spawned) since the 2nd attempt succeeded
    assert.equal(
      res.status, 202,
      `Expected 202 for successful retry spawn, got ${res.status}: ${res.body}`,
    );

    // 2 spawn attempts were made: 1 failure + 1 success
    assert.equal(spawnCallCount, 2, `Expected 2 spawn attempts (1 fail + 1 success), got ${spawnCallCount}`);

    // Task should NOT be failed
    const rows = query<{ status: string }>(
      `SELECT status FROM tasks WHERE kind = 'orchestrator' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.status, 'failed', 'Task should not be failed when 2nd spawn succeeded');
  });
});
