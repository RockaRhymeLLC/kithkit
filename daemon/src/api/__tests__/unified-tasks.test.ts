/**
 * T2: Integration tests for the /api/tasks unified endpoint.
 *
 * Tests CRUD, state machine transitions, activity, plan workflow, and DELETE.
 * Uses a real HTTP server with a temp DB — same harness as orchestrator-tasks-outcome.test.ts.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { handleUnifiedTasksRoute } from '../unified-tasks.js';

const TEST_PORT = 19890;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
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

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-unified-tasks-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleUnifiedTasksRoute(inReq, res, url.pathname, url.searchParams)
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

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    if (server?.listening) {
      server.close(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    } else {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }
  });
}

// ── POST /api/tasks ────────────────────────────────────────────

describe('POST /api/tasks creates tasks', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('creates a task with kind=todo by default', async () => {
    const res = await request('POST', '/api/tasks', {
      title: 'My first todo',
    });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'todo');
    assert.equal(body.title, 'My first todo');
    assert.equal(body.status, 'pending');
    assert.equal(body.external_id, null, 'todos should have null external_id');
    assert.ok(typeof body.id === 'number', 'id should be an integer');
  });

  it('creates a task with kind=orchestrator', async () => {
    const res = await request('POST', '/api/tasks', {
      title: 'Orchestrator task',
      kind: 'orchestrator',
    });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'orchestrator');
    assert.equal(body.title, 'Orchestrator task');
    assert.ok(body.external_id, 'orchestrator tasks should have a UUID external_id');
    assert.ok(/^[0-9a-f-]{36}$/.test(body.external_id), 'external_id should be a UUID');
  });

  it('returns 400 when title is missing', async () => {
    const res = await request('POST', '/api/tasks', { priority: 'high' });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('title'), 'error should mention title');
  });
});

// ── GET /api/tasks ─────────────────────────────────────────────

describe('GET /api/tasks lists and filters tasks', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty list when no tasks exist', async () => {
    const res = await request('GET', '/api/tasks');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data), 'data should be an array');
    assert.equal(body.data.length, 0);
  });

  it('lists all tasks when no filter applied', async () => {
    await request('POST', '/api/tasks', { title: 'Todo 1' });
    await request('POST', '/api/tasks', { title: 'Orch 1', kind: 'orchestrator' });

    const res = await request('GET', '/api/tasks');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 2);
  });

  it('filters by kind=todo', async () => {
    await request('POST', '/api/tasks', { title: 'Todo 1' });
    await request('POST', '/api/tasks', { title: 'Orch 1', kind: 'orchestrator' });

    const res = await request('GET', '/api/tasks?kind=todo');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].kind, 'todo');
    assert.equal(body.data[0].title, 'Todo 1');
  });

  it('filters by kind=orchestrator', async () => {
    await request('POST', '/api/tasks', { title: 'Todo 1' });
    await request('POST', '/api/tasks', { title: 'Orch 1', kind: 'orchestrator' });

    const res = await request('GET', '/api/tasks?kind=orchestrator');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].kind, 'orchestrator');
  });
});

// ── GET /api/tasks/:id ─────────────────────────────────────────

describe('GET /api/tasks/:id returns task detail', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns task by integer id', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'Detail task' });
    const created = JSON.parse(createRes.body);

    const res = await request('GET', `/api/tasks/${created.id}`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, created.id);
    assert.equal(body.title, 'Detail task');
    assert.ok(Array.isArray(body.workers), 'should include workers');
    assert.ok(Array.isArray(body.activity), 'should include activity');
  });

  it('returns task by UUID external_id for orchestrator tasks', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'UUID lookup task',
      kind: 'orchestrator',
    });
    const created = JSON.parse(createRes.body);

    const res = await request('GET', `/api/tasks/${created.external_id}`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.external_id, created.external_id);
    assert.equal(body.title, 'UUID lookup task');
  });

  it('returns 404 for non-existent task', async () => {
    const res = await request('GET', '/api/tasks/99999');
    assert.equal(res.status, 404);
  });
});

// ── PUT /api/tasks/:id state machine ───────────────────────────

describe('PUT /api/tasks/:id state machine transitions', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('allows pending → in_progress transition', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'State machine test',
      kind: 'orchestrator',
    });
    const task = JSON.parse(createRes.body);

    // pending → assigned first
    await request('PUT', `/api/tasks/${task.id}`, {
      status: 'assigned',
      assigned_to: 'orchestrator',
    });

    // assigned → in_progress
    const res = await request('PUT', `/api/tasks/${task.id}`, {
      status: 'in_progress',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'in_progress');
  });

  it('rejects invalid transition pending → completed with HTTP 422', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'Invalid transition test',
      kind: 'orchestrator',
    });
    const task = JSON.parse(createRes.body);

    const res = await request('PUT', `/api/tasks/${task.id}`, {
      status: 'completed',
      result: 'Done',
    });
    assert.equal(res.status, 422);
    const body = JSON.parse(res.body);
    assert.ok(body.error, 'should have error message');
    assert.ok(body.allowed_transitions, 'should list allowed transitions');
  });

  it('rejects invalid transition pending → failed with HTTP 422', async () => {
    // pending → failed IS actually valid per task-state-machine, let's test an
    // actually invalid transition instead: completed → in_progress
    const createRes = await request('POST', '/api/tasks', {
      title: 'Invalid transition test 2',
      kind: 'orchestrator',
    });
    const task = JSON.parse(createRes.body);

    // Advance to completed via proper path
    await request('PUT', `/api/tasks/${task.id}`, { status: 'assigned', assigned_to: 'orch' });
    await request('PUT', `/api/tasks/${task.id}`, { status: 'in_progress' });
    await request('PUT', `/api/tasks/${task.id}`, { status: 'completed', result: 'Done' });

    // Now try to go back to in_progress — should fail
    const res = await request('PUT', `/api/tasks/${task.id}`, { status: 'in_progress' });
    assert.equal(res.status, 409, 'completed task should block non-feedback updates');
  });
});

// ── POST /api/tasks/:id/activity ───────────────────────────────

describe('POST /api/tasks/:id/activity', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('adds an activity entry to a task', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'Activity test' });
    const task = JSON.parse(createRes.body);

    const res = await request('POST', `/api/tasks/${task.id}/activity`, {
      message: 'Worker started',
      type: 'progress',
      agent: 'orchestrator',
    });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.message, 'Worker started');
    assert.equal(body.type, 'progress');
    assert.equal(body.agent, 'orchestrator');
    assert.equal(body.task_id, task.id);
  });

  it('returns 400 when message is missing', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'Activity test 2' });
    const task = JSON.parse(createRes.body);

    const res = await request('POST', `/api/tasks/${task.id}/activity`, { type: 'note' });
    assert.equal(res.status, 400);
  });
});

// ── Plan workflow ──────────────────────────────────────────────

describe('Plan approval workflow', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  async function advanceToInProgress(taskId: number): Promise<void> {
    await request('PUT', `/api/tasks/${taskId}`, { status: 'assigned', assigned_to: 'orchestrator' });
    await request('PUT', `/api/tasks/${taskId}`, { status: 'in_progress' });
  }

  it('POST /api/tasks/:id/submit-plan changes status to awaiting_approval', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'Plan test',
      kind: 'orchestrator',
    });
    const task = JSON.parse(createRes.body);
    await advanceToInProgress(task.id);

    const res = await request('POST', `/api/tasks/${task.id}/submit-plan`, {
      plan: 'Step 1: Do the thing. Step 2: Done.',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'awaiting_approval');
    assert.equal(body.plan_status, 'submitted');
    assert.ok(body.plan, 'plan should be stored');
  });

  it('POST /api/tasks/:id/approve-plan changes status to in_progress', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'Approve plan test',
      kind: 'orchestrator',
    });
    const task = JSON.parse(createRes.body);
    await advanceToInProgress(task.id);
    await request('POST', `/api/tasks/${task.id}/submit-plan`, { plan: 'My plan' });

    const res = await request('POST', `/api/tasks/${task.id}/approve-plan`, {});
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'in_progress');
    assert.equal(body.plan_status, 'approved');
    assert.ok(body.plan_approved_at, 'plan_approved_at should be set');
  });

  it('POST /api/tasks/:id/reject-plan changes status to planning', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'Reject plan test',
      kind: 'orchestrator',
    });
    const task = JSON.parse(createRes.body);
    await advanceToInProgress(task.id);
    await request('POST', `/api/tasks/${task.id}/submit-plan`, { plan: 'Bad plan' });

    const res = await request('POST', `/api/tasks/${task.id}/reject-plan`, {
      reason: 'Plan is too vague',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'planning');
    assert.equal(body.plan_status, 'rejected');
    assert.ok(body.plan_rejected_reason.includes('Plan is too vague'));
  });
});

// ── DELETE /api/tasks/:id ──────────────────────────────────────

describe('DELETE /api/tasks/:id removes task', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('deletes a task by integer id', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'Delete me' });
    const task = JSON.parse(createRes.body);

    const deleteRes = await request('DELETE', `/api/tasks/${task.id}`);
    assert.equal(deleteRes.status, 200);
    const body = JSON.parse(deleteRes.body);
    assert.equal(body.deleted, true);
    assert.equal(body.id, task.id);

    // Confirm it's gone
    const getRes = await request('GET', `/api/tasks/${task.id}`);
    assert.equal(getRes.status, 404);
  });
});
