/**
 * Comms feedback revision tests for orchestrator tasks.
 *
 * Tests:
 *   1. comms can PUT new comms_outcome on an already-acknowledged (completed) task
 *   2. comms can PUT new comms_corrections JSON on an already-acknowledged task
 *   3. acknowledged_at is blocked on non-terminal tasks (guard: orch cannot pre-ack)
 *   4. Non-feedback fields still blocked on terminal tasks (regression)
 *   5. GET returns current comms_outcome + comms_corrections (retro reads latest row)
 *   6. comms_outcome validation — invalid value rejected with 400
 *   7. acknowledged_at + comms_outcome can be set together on terminal task
 *   8. Comms can update comms_outcome on cancelled task
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { handleTaskQueueRoute, _setEvaluateTaskFnForTesting } from '../task-queue.js';

const TEST_PORT = 19873;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-comms-feedback-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Suppress retro evaluation in all tests
  _setEvaluateTaskFnForTesting(async (_id) => { /* no-op */ });

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
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

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  _setEvaluateTaskFnForTesting(null);
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

async function createTask(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await request('POST', '/api/orchestrator/tasks', {
    title: 'Comms feedback test task',
    ...overrides,
  });
  assert.equal(res.status, 201);
  return JSON.parse(res.body) as Record<string, unknown>;
}

/** Advance a task to completed status. */
async function completeTask(taskId: string, result = 'Done'): Promise<void> {
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'assigned', assignee: 'orchestrator',
  });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'in_progress',
  });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'completed', result,
  });
}

/** Advance a task to failed status. */
async function failTask(taskId: string): Promise<void> {
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'assigned', assignee: 'orchestrator',
  });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'in_progress',
  });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'failed', error: 'Worker crashed',
  });
}

// ── Tests ──────────────────────────────────────────────────────

describe('Comms feedback — revisable on closed tasks', { concurrency: 1 }, () => {

  describe('Test 1: revise comms_outcome on already-acknowledged task', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('comms can update comms_outcome after it was initially set on a completed task', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      // Initial ack
      const ack = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'accepted',
        acknowledged_at: new Date().toISOString(),
      });
      assert.equal(ack.status, 200);
      assert.equal(JSON.parse(ack.body).comms_outcome, 'accepted');

      // Later: human complains — revise to corrected
      const revision = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'corrected',
      });
      assert.equal(revision.status, 200, `Expected 200, got: ${revision.body}`);
      assert.equal(JSON.parse(revision.body).comms_outcome, 'corrected');

      // Verify GET reflects the revision
      const get = await request('GET', `/api/orchestrator/tasks/${task.id}`);
      assert.equal(get.status, 200);
      assert.equal(JSON.parse(get.body).comms_outcome, 'corrected');
    });
  });

  describe('Test 2: revise comms_corrections JSON on already-acknowledged task', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('comms can update comms_corrections after initial ack', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      // Initial ack with corrections
      const initialCorrections = JSON.stringify({ v1: 'First assessment' });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'corrected',
        comms_corrections: initialCorrections,
        acknowledged_at: new Date().toISOString(),
      });

      // Later: more context available — update corrections
      const revisedCorrections = JSON.stringify({
        v1: 'First assessment',
        v2: 'Revised: user confirmed the output was wrong',
      });
      const revision = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_corrections: revisedCorrections,
      });
      assert.equal(revision.status, 200, `Expected 200, got: ${revision.body}`);
      assert.equal(JSON.parse(revision.body).comms_corrections, revisedCorrections);

      // Verify GET reflects revised corrections
      const get = await request('GET', `/api/orchestrator/tasks/${task.id}`);
      assert.equal(get.status, 200);
      assert.equal(JSON.parse(get.body).comms_corrections, revisedCorrections);
    });
  });

  describe('Test 3: acknowledged_at blocked on non-terminal tasks', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('PUT with acknowledged_at on in_progress task returns 409', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        acknowledged_at: new Date().toISOString(),
      });
      assert.equal(res.status, 409, `Expected 409 blocking premature ack, got: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.ok(
        body.error.includes('acknowledged_at') || body.error.includes('terminal'),
        `Error should mention acknowledged_at or terminal: ${body.error}`,
      );
    });

    it('PUT with acknowledged_at on pending task returns 409', async () => {
      const task = await createTask();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        acknowledged_at: new Date().toISOString(),
      });
      assert.equal(res.status, 409, `Expected 409, got: ${res.body}`);
    });

    it('PUT with acknowledged_at on assigned task returns 409', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        acknowledged_at: new Date().toISOString(),
      });
      assert.equal(res.status, 409, `Expected 409, got: ${res.body}`);
    });
  });

  describe('Test 4: non-feedback fields still blocked on terminal tasks (regression)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('PUT with status change on completed task returns 409', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      assert.equal(res.status, 409, `Expected 409, got: ${res.body}`);
    });

    it('PUT with result change on completed task returns 409', async () => {
      const task = await createTask();
      await completeTask(task.id as string, 'Original result');

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        result: 'Overwritten result',
      });
      assert.equal(res.status, 409, `Expected 409, got: ${res.body}`);
    });

    it('PUT with non-feedback + comms_outcome mixed on terminal task returns 409', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'accepted',
        result: 'Attempt to overwrite result',
      });
      assert.equal(res.status, 409, `Expected 409 for mixed update, got: ${res.body}`);
    });

    it('PUT with empty body on completed task returns 409 (no comms feedback provided)', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {});
      assert.equal(res.status, 409, `Expected 409 for empty update on terminal task, got: ${res.body}`);
    });
  });

  describe('Test 5: GET returns current comms_outcome + comms_corrections (retro reads latest row)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('GET after feedback revision returns the most recent comms_outcome', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      // First ack
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'accepted',
        acknowledged_at: new Date().toISOString(),
      });

      // Revise
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'redirected',
        comms_corrections: JSON.stringify({ note: 'work was redirected mid-flight' }),
      });

      const get = await request('GET', `/api/orchestrator/tasks/${task.id}`);
      assert.equal(get.status, 200);
      const body = JSON.parse(get.body);
      assert.equal(body.comms_outcome, 'redirected', 'GET should return latest comms_outcome');
      assert.ok(
        body.comms_corrections?.includes('redirected'),
        'GET should return latest comms_corrections',
      );
    });

    it('GET /tasks list includes comms_outcome in task rows', async () => {
      const task = await createTask();
      await completeTask(task.id as string);
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'accepted',
        acknowledged_at: new Date().toISOString(),
      });

      const listRes = await request('GET', '/api/orchestrator/tasks?status=completed');
      assert.equal(listRes.status, 200);
      const body = JSON.parse(listRes.body);
      const found = body.data.find((t: { id: string }) => t.id === task.id);
      assert.ok(found, 'task should appear in list');
      assert.equal(found.comms_outcome, 'accepted');
    });

    it('new tasks have comms_outcome=null and acknowledged_at=null by default', async () => {
      const task = await createTask();
      const get = await request('GET', `/api/orchestrator/tasks/${task.id}`);
      assert.equal(get.status, 200);
      const body = JSON.parse(get.body);
      assert.equal(body.comms_outcome, null);
      assert.equal(body.comms_corrections, null);
      assert.equal(body.acknowledged_at, null);
    });
  });

  describe('Test 6: comms_outcome validation', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns 400 for invalid comms_outcome value', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'excellent',
      });
      assert.equal(res.status, 400, `Expected 400, got: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('comms_outcome'), `Error should mention comms_outcome: ${body.error}`);
    });

    it('accepts all valid comms_outcome values', async () => {
      for (const outcome of ['accepted', 'corrected', 'redirected', 'cancelled']) {
        const task = await createTask();
        await completeTask(task.id as string);

        const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
          comms_outcome: outcome,
        });
        assert.equal(res.status, 200, `Expected 200 for comms_outcome=${outcome}, got: ${res.body}`);
        assert.equal(JSON.parse(res.body).comms_outcome, outcome);
      }
    });

    it('accepts comms_outcome=null to clear the field', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'accepted',
      });
      const clear = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: null,
      });
      assert.equal(clear.status, 200);
      assert.equal(JSON.parse(clear.body).comms_outcome, null);
    });
  });

  describe('Test 7: acknowledged_at + comms_outcome set together on terminal task', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('can set acknowledged_at alongside comms_outcome on a completed task', async () => {
      const task = await createTask();
      await completeTask(task.id as string);

      const ackTime = new Date().toISOString();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'accepted',
        acknowledged_at: ackTime,
      });
      assert.equal(res.status, 200, `Expected 200, got: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.equal(body.comms_outcome, 'accepted');
      assert.equal(body.acknowledged_at, ackTime);
      assert.equal(body.status, 'completed', 'status should remain completed');
    });
  });

  describe('Test 8: comms feedback works on cancelled tasks', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('comms can set comms_outcome on a cancelled task', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      // Cancel via dedicated endpoint
      const cancelRes = await request('POST', `/api/orchestrator/tasks/${task.id}/cancel`);
      assert.equal(cancelRes.status, 200);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        comms_outcome: 'cancelled',
        acknowledged_at: new Date().toISOString(),
      });
      assert.equal(res.status, 200, `Expected 200 on cancelled task, got: ${res.body}`);
      assert.equal(JSON.parse(res.body).comms_outcome, 'cancelled');
    });
  });

});
