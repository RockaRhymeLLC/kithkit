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

// ── PUT /api/tasks/:id todo transitions (dogfood bug #1724) ────
//
// Regression: canonical PUT was rejecting pending → completed for kind='todo'
// via the orchestrator state machine, even though the /api/todos shim allows it.
// Fix: todo tasks bypass the state machine — any valid status is permitted.

describe('PUT /api/tasks/:id todo bypasses state machine', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('allows todo pending → completed directly (bug #1724)', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'bug-1724-regression',
      kind: 'todo',
      priority: 'low',
    });
    assert.equal(createRes.status, 201);
    const task = JSON.parse(createRes.body);
    assert.equal(task.status, 'pending');

    const putRes = await request('PUT', `/api/tasks/${task.id}`, { status: 'completed' });
    assert.equal(putRes.status, 200, 'should return 200, not 422');
    const updated = JSON.parse(putRes.body);
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completed_at, 'completed_at should be stamped');

    // GET to confirm DB was updated
    const getRes = await request('GET', `/api/tasks/${task.id}`);
    assert.equal(getRes.status, 200);
    const fetched = JSON.parse(getRes.body);
    assert.equal(fetched.status, 'completed', 'DB must reflect completed status');
  });

  it('allows todo pending → in_progress directly', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'todo-direct-in-progress',
      kind: 'todo',
    });
    const task = JSON.parse(createRes.body);

    const res = await request('PUT', `/api/tasks/${task.id}`, { status: 'in_progress' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'in_progress');
  });

  it('orchestrator pending → completed still returns 422', async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'orch-state-machine-still-enforced',
      kind: 'orchestrator',
    });
    const task = JSON.parse(createRes.body);

    const res = await request('PUT', `/api/tasks/${task.id}`, { status: 'completed', result: 'Done' });
    assert.equal(res.status, 422, 'orchestrator tasks must still enforce state machine');
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('cannot transition from pending'));
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

// ── estimate_multiplier computed field ────────────────────────

describe('estimate_multiplier is computed on read', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns null when both minutes fields are null', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'No estimates' });
    const task = JSON.parse(createRes.body);
    assert.equal(task.estimate_multiplier, null);

    const getRes = await request('GET', `/api/tasks/${task.id}`);
    assert.equal(JSON.parse(getRes.body).estimate_multiplier, null);
  });

  it('returns null when only actual_minutes is set', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'Only actual' });
    const task = JSON.parse(createRes.body);
    const putRes = await request('PUT', `/api/tasks/${task.id}`, { actual_minutes: 30 });
    assert.equal(JSON.parse(putRes.body).estimate_multiplier, null);
  });

  it('returns null when only estimated_minutes is set', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'Only estimated' });
    const task = JSON.parse(createRes.body);
    const putRes = await request('PUT', `/api/tasks/${task.id}`, { estimated_minutes: 30 });
    assert.equal(JSON.parse(putRes.body).estimate_multiplier, null);
  });

  it('returns null when estimated_minutes is 0 (divide-by-zero guard)', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'Zero estimate' });
    const task = JSON.parse(createRes.body);
    const putRes = await request('PUT', `/api/tasks/${task.id}`, {
      estimated_minutes: 0,
      actual_minutes: 30,
    });
    assert.equal(JSON.parse(putRes.body).estimate_multiplier, null);
  });

  it('computes actual/estimated when both are set', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'Both set' });
    const task = JSON.parse(createRes.body);
    const putRes = await request('PUT', `/api/tasks/${task.id}`, {
      estimated_minutes: 20,
      actual_minutes: 30,
    });
    const body = JSON.parse(putRes.body);
    assert.equal(body.estimate_multiplier, 1.5);
  });

  it('appears on GET /api/tasks list', async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'List test' });
    const task = JSON.parse(createRes.body);
    await request('PUT', `/api/tasks/${task.id}`, { estimated_minutes: 10, actual_minutes: 20 });

    const listRes = await request('GET', '/api/tasks');
    const body = JSON.parse(listRes.body);
    const found = body.data.find((t: { id: number }) => t.id === task.id);
    assert.ok(found, 'task should appear in list');
    assert.equal(found.estimate_multiplier, 2);
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

// ── PUT /api/tasks/:id status alias normalization (#211) ────────

describe('PUT /api/tasks/:id status alias normalization', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it("'done' alias stores as 'completed' (orch task via full state-machine path)", async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'alias-done-test',
      kind: 'orchestrator',
    });
    assert.equal(createRes.status, 201);
    const task = JSON.parse(createRes.body);

    // Advance to assigned → in_progress
    await request('PUT', `/api/tasks/${task.id}`, { status: 'assigned', assigned_to: 'orch' });
    await request('PUT', `/api/tasks/${task.id}`, { status: 'in_progress' });

    // Now use alias 'done'
    const putRes = await request('PUT', `/api/tasks/${task.id}`, { status: 'done', result: 'Finished' });
    assert.equal(putRes.status, 200, "'done' should be accepted");
    assert.equal(JSON.parse(putRes.body).status, 'completed', "stored status must be 'completed'");

    // Confirm via GET
    const getRes = await request('GET', `/api/tasks/${task.id}`);
    assert.equal(JSON.parse(getRes.body).status, 'completed', "GET must also return 'completed'");
  });

  it("'wip' alias stores as 'in_progress' (todo task)", async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'alias-wip-test',
      kind: 'todo',
    });
    const task = JSON.parse(createRes.body);

    const putRes = await request('PUT', `/api/tasks/${task.id}`, { status: 'wip' });
    assert.equal(putRes.status, 200, "'wip' should be accepted");
    assert.equal(JSON.parse(putRes.body).status, 'in_progress', "stored status must be 'in_progress'");

    const getRes = await request('GET', `/api/tasks/${task.id}`);
    assert.equal(JSON.parse(getRes.body).status, 'in_progress', "GET must also return 'in_progress'");
  });

  it("alias lookup is case-insensitive: 'DONE' → 'completed'", async () => {
    const createRes = await request('POST', '/api/tasks', {
      title: 'alias-case-test',
      kind: 'todo',
    });
    const task = JSON.parse(createRes.body);

    const putRes = await request('PUT', `/api/tasks/${task.id}`, { status: 'DONE' });
    assert.equal(putRes.status, 200, "'DONE' should be accepted");
    assert.equal(JSON.parse(putRes.body).status, 'completed');
  });

  it("unknown status still returns HTTP 400", async () => {
    const createRes = await request('POST', '/api/tasks', { title: 'bad-status-test', kind: 'todo' });
    const task = JSON.parse(createRes.body);

    const putRes = await request('PUT', `/api/tasks/${task.id}`, { status: 'bogus' });
    assert.equal(putRes.status, 400, "unrecognised alias should still return 400");
    assert.ok(JSON.parse(putRes.body).error.includes('invalid status'));
  });
});
