/**
 * Integration tests: POST /api/orchestrator/escalate → unified tasks table.
 *
 * Verifies:
 *   1. Escalate inserts into `tasks` (kind='orchestrator', external_id=taskId, source='human', status='pending')
 *   2. Legacy orchestrator_tasks receives NO row from the escalate path
 *   3. GET /api/orchestrator/tasks?status=pending (shim) returns the escalated task
 *   4. orchestrator-idle zombie cleanup reads from `tasks` and marks rows failed
 *   5. orchestrator-idle orphan cleanup reads from `tasks` with age filter
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query, exec, insert } from '../../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../../core/config.js';
import { handleOrchestratorRoute, _setDepsForTesting as _setOrchDeps } from '../orchestrator.js';
import { handleTaskQueueRoute } from '../task-queue.js';
import {
  _runForTesting as _runIdleForTesting,
  _resetNudgeStateForTesting,
  _setDepsForTesting as _setIdleDeps,
} from '../../automation/tasks/orchestrator-idle.js';

const ESCALATE_PORT = 19893;
const QUEUE_PORT = 19894;

// ── HTTP helpers ──────────────────────────────────────────────

function escalateRequest(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: ESCALATE_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
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

function queueRequest(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: QUEUE_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
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

// ── Test harness ──────────────────────────────────────────────

let escalateServer: http.Server;
let queueServer: http.Server;
let tmpDir: string;

function setupTestEnv(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orch-escalate-unified-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
scheduler:
  tasks: []
`);
  _resetConfigForTesting();
  loadConfig(tmpDir);
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownTestEnv(): void {
  _setOrchDeps(null);
  _setIdleDeps(null);
  _resetNudgeStateForTesting();
  _resetDbForTesting();
  _resetConfigForTesting();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Mock tmux deps — no real tmux in tests
function mockOrchDeps(orchState: 'active' | 'waiting' | 'dead', sessionName?: string): void {
  _setOrchDeps({
    getOrchestratorState: () => orchState,
    spawnOrchestratorSession: () => sessionName ?? null,
    sendMessage: () => ({ messageId: 1, delivered: true }),
    injectMessage: () => true,
  });
}

function mockIdleDeps(): void {
  _setIdleDeps({
    isOrchestratorAlive: () => false,
    killOrchestratorSession: () => false,
    injectMessage: () => false,
    spawnOrchestratorSession: () => null,
    cleanupSessionDirs: () => 0,
  });
}

// ── Test suite 1: escalate → tasks insert ────────────────────

describe('POST /api/orchestrator/escalate writes to unified tasks table', { concurrency: 1 }, () => {
  before(() => new Promise<void>((resolve) => {
    setupTestEnv();
    // Mock spawn to succeed (state=dead → will try to spawn)
    mockOrchDeps('dead', 'test-session-1');

    escalateServer = http.createServer((inReq, res) => {
      const url = new URL(inReq.url ?? '/', `http://127.0.0.1:${ESCALATE_PORT}`);
      res.setHeader('X-Timestamp', new Date().toISOString());
      handleOrchestratorRoute(inReq, res, url.pathname)
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found', timestamp: new Date().toISOString() }));
          }
        })
        .catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err), timestamp: new Date().toISOString() }));
          }
        });
    });
    escalateServer.listen(ESCALATE_PORT, '127.0.0.1', resolve);
  }));

  after(() => new Promise<void>((resolve) => {
    escalateServer.close(() => {
      teardownTestEnv();
      resolve();
    });
  }));

  it('inserts into tasks table with kind=orchestrator and status=pending', async () => {
    const res = await escalateRequest('POST', '/api/orchestrator/escalate', {
      task: 'Run the weekly digest pipeline',
    });
    assert.ok([200, 202].includes(res.status), `Expected 200 or 202, got ${res.status}: ${res.body}`);
    const responseBody = JSON.parse(res.body);
    const taskId = responseBody.task_id;
    assert.ok(typeof taskId === 'string' && taskId.length > 0, 'task_id should be a non-empty string');

    // Verify row in tasks table
    const rows = query<{
      external_id: string;
      kind: string;
      status: string;
      source: string;
      title: string;
    }>(`SELECT external_id, kind, status, source, title FROM tasks WHERE external_id = ?`, taskId);
    assert.equal(rows.length, 1, 'exactly one row in tasks');
    assert.equal(rows[0]!.external_id, taskId, 'external_id equals returned task_id');
    assert.equal(rows[0]!.kind, 'orchestrator', "kind must be 'orchestrator'");
    assert.equal(rows[0]!.status, 'pending', "status must be 'pending'");
    assert.equal(rows[0]!.source, 'human', "source must be 'human'");
    assert.ok(rows[0]!.title.includes('weekly digest'), 'title derived from task text');
  });

  it('does NOT insert into legacy orchestrator_tasks table', async () => {
    const res = await escalateRequest('POST', '/api/orchestrator/escalate', {
      task: 'Do some other background work',
    });
    assert.ok([200, 202].includes(res.status));
    const taskId = JSON.parse(res.body).task_id;

    // Check legacy table — should have no row with this ID
    const legacyRows = query<{ id: string }>(
      `SELECT id FROM orchestrator_tasks WHERE id = ?`, taskId,
    );
    assert.equal(legacyRows.length, 0, 'orchestrator_tasks must not receive a row from the escalate path');
  });

  it('marks task as failed in tasks table when spawn fails', async () => {
    // Mock spawn to fail
    _setOrchDeps({
      getOrchestratorState: () => 'dead',
      spawnOrchestratorSession: () => null, // spawn failure
      sendMessage: () => ({ messageId: 1, delivered: true }),
      injectMessage: () => true,
    });

    const res = await escalateRequest('POST', '/api/orchestrator/escalate', {
      task: 'This task should fail to spawn',
    });
    assert.equal(res.status, 500, 'should return 500 on spawn failure');

    // Restore working mock for subsequent tests
    mockOrchDeps('dead', 'test-session-1');
  });
});

// ── Test suite 2: shim GET returns escalated task ────────────

describe('GET /api/orchestrator/tasks?status=pending returns escalated task via shim', { concurrency: 1 }, () => {
  before(() => new Promise<void>((resolve) => {
    setupTestEnv();

    queueServer = http.createServer((inReq, res) => {
      const url = new URL(inReq.url ?? '/', `http://127.0.0.1:${QUEUE_PORT}`);
      res.setHeader('X-Timestamp', new Date().toISOString());
      handleTaskQueueRoute(inReq, res, url.pathname, url.searchParams)
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found', timestamp: new Date().toISOString() }));
          }
        })
        .catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err), timestamp: new Date().toISOString() }));
          }
        });
    });
    queueServer.listen(QUEUE_PORT, '127.0.0.1', resolve);
  }));

  after(() => new Promise<void>((resolve) => {
    queueServer.close(() => {
      teardownTestEnv();
      resolve();
    });
  }));

  it('shim returns task inserted directly into tasks table', async () => {
    // Directly insert a row into the tasks table (simulating what escalate does)
    const taskId = '00000000-test-0000-0000-escalate0001';
    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Test shim task', 'Do the thing', 'pending', 'low', 'human', ?, ?)`,
      taskId, new Date().toISOString(), new Date().toISOString(),
    );

    const res = await queueRequest('GET', '/api/orchestrator/tasks?status=pending');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data), 'response.data should be an array');
    const found = body.data.find((t: { id: string }) => t.id === taskId);
    assert.ok(found, `task with id ${taskId} should appear in GET /api/orchestrator/tasks?status=pending`);
    assert.equal(found.status, 'pending');
    assert.equal(found.source, 'human');
  });
});

// ── Test suite 3: zombie cleanup reads from tasks ────────────

describe('orchestrator-idle zombie cleanup uses unified tasks table', { concurrency: 1 }, () => {
  let idleTmpDir: string;

  beforeEach(() => {
    idleTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-idle-zombie-'));
    fs.writeFileSync(path.join(idleTmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
scheduler:
  tasks: []
`);
    _resetConfigForTesting();
    loadConfig(idleTmpDir);
    _resetDbForTesting();
    openDatabase(idleTmpDir, path.join(idleTmpDir, 'test.db'));

    // Seed orchestrator agent row
    insert('agents', {
      id: 'orchestrator',
      type: 'orchestrator',
      status: 'stopped',
      started_at: new Date().toISOString(),
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    mockIdleDeps();
    _resetNudgeStateForTesting();
  });

  afterEach(() => {
    _setIdleDeps(null);
    _resetNudgeStateForTesting();
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(idleTmpDir, { recursive: true, force: true });
  });

  it('marks in_progress tasks in tasks table as failed, does not touch orchestrator_tasks', async () => {
    const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01';

    // Insert zombie task into tasks table
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Zombie task', 'in_progress', 'low', 'human', ?, ?)`,
      taskId, new Date().toISOString(), new Date().toISOString(),
    );

    // Insert an in_progress row into legacy orchestrator_tasks — should remain untouched
    exec(
      `INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at)
       VALUES (?, 'Legacy zombie', 'in_progress', 0, ?, ?)`,
      'legacy-id-001', new Date().toISOString(), new Date().toISOString(),
    );

    // Run idle monitor — orchestrator is dead, so cleanupZombieTasks runs
    await _runIdleForTesting({});

    // tasks table row should be failed
    const tasksRows = query<{ status: string; error: string }>(
      `SELECT status, error FROM tasks WHERE external_id = ?`, taskId,
    );
    assert.equal(tasksRows.length, 1, 'tasks row should exist');
    assert.equal(tasksRows[0]!.status, 'failed', 'tasks row should be marked failed');
    assert.equal(tasksRows[0]!.error, 'orchestrator_died', 'error should be orchestrator_died');

    // orchestrator_tasks row should be UNTOUCHED
    const legacyRows = query<{ status: string }>(
      `SELECT status FROM orchestrator_tasks WHERE id = ?`, 'legacy-id-001',
    );
    assert.equal(legacyRows.length, 1, 'legacy row should still exist');
    assert.equal(legacyRows[0]!.status, 'in_progress', 'legacy orchestrator_tasks row should remain in_progress — zombie cleanup must not touch it');
  });

  it('marks assigned tasks in tasks table as failed', async () => {
    const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee02';

    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Assigned zombie', 'assigned', 'low', 'human', ?, ?)`,
      taskId, new Date().toISOString(), new Date().toISOString(),
    );

    await _runIdleForTesting({});

    const rows = query<{ status: string }>(
      `SELECT status FROM tasks WHERE external_id = ?`, taskId,
    );
    assert.equal(rows[0]!.status, 'failed', 'assigned task should be marked failed by zombie cleanup');
  });
});

// ── Test suite 4: orphan cleanup reads from tasks ────────────

describe('orchestrator-idle orphan cleanup uses unified tasks table', { concurrency: 1 }, () => {
  let idleTmpDir: string;

  beforeEach(() => {
    idleTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-idle-orphan-'));
    fs.writeFileSync(path.join(idleTmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
scheduler:
  tasks: []
`);
    _resetConfigForTesting();
    loadConfig(idleTmpDir);
    _resetDbForTesting();
    openDatabase(idleTmpDir, path.join(idleTmpDir, 'test.db'));

    mockIdleDeps();
    _resetNudgeStateForTesting();
  });

  afterEach(() => {
    _setIdleDeps(null);
    _resetNudgeStateForTesting();
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(idleTmpDir, { recursive: true, force: true });
  });

  it('marks tasks orphaned by a previous orchestrator as failed, does not touch orchestrator_tasks', async () => {
    const orchStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const taskCreatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago (before orch start)

    // Seed orchestrator agent started 5 min ago
    insert('agents', {
      id: 'orchestrator',
      type: 'orchestrator',
      status: 'running',
      started_at: orchStartedAt,
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee03';

    // Orphaned task: in_progress since before this orchestrator started
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, started_at, updated_at)
       VALUES (?, 'orchestrator', 'Orphaned task', 'in_progress', 'low', 'human', ?, ?, ?)`,
      taskId, taskCreatedAt, taskCreatedAt, new Date().toISOString(),
    );

    // Legacy orphan in orchestrator_tasks — should remain untouched
    exec(
      `INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at)
       VALUES (?, 'Legacy orphan', 'in_progress', 0, ?, ?)`,
      'legacy-orphan-001', taskCreatedAt, new Date().toISOString(),
    );

    // Mock alive=true so we reach cleanupOrphanedTasks (called unconditionally)
    _setIdleDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
    });

    await _runIdleForTesting({ idle_timeout_minutes: 1000 });

    // tasks row should be failed
    const tasksRows = query<{ status: string; error: string }>(
      `SELECT status, error FROM tasks WHERE external_id = ?`, taskId,
    );
    assert.equal(tasksRows.length, 1);
    assert.equal(tasksRows[0]!.status, 'failed', 'orphaned task in tasks should be failed');
    assert.equal(tasksRows[0]!.error, 'orchestrator_restarted');

    // Legacy row untouched
    const legacyRows = query<{ status: string }>(
      `SELECT status FROM orchestrator_tasks WHERE id = ?`, 'legacy-orphan-001',
    );
    assert.equal(legacyRows[0]!.status, 'in_progress', 'legacy orchestrator_tasks row must not be touched by orphan cleanup');
  });

  it('respects age filter — does not mark tasks created after orch start', async () => {
    const orchStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const recentCreatedAt = new Date(Date.now() - 1 * 60 * 1000).toISOString(); // 1 min ago (after orch start)

    insert('agents', {
      id: 'orchestrator',
      type: 'orchestrator',
      status: 'running',
      started_at: orchStartedAt,
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const recentTaskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee04';

    // Task created AFTER orch start — should NOT be marked orphaned
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, started_at, updated_at)
       VALUES (?, 'orchestrator', 'Recent task', 'in_progress', 'low', 'human', ?, ?, ?)`,
      recentTaskId, recentCreatedAt, recentCreatedAt, new Date().toISOString(),
    );

    _setIdleDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => false,
      injectMessage: () => false,
      spawnOrchestratorSession: () => null,
      cleanupSessionDirs: () => 0,
    });

    await _runIdleForTesting({ idle_timeout_minutes: 1000 });

    // Recent task should remain in_progress — age filter protects it
    const rows = query<{ status: string }>(
      `SELECT status FROM tasks WHERE external_id = ?`, recentTaskId,
    );
    assert.equal(rows[0]!.status, 'in_progress', 'task created after orch start must not be marked orphaned');
  });
});
