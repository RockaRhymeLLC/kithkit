/**
 * Outcome tagging tests for orchestrator tasks (Story 10 — Self-Improvement Loop).
 *
 * Tests:
 *   1. PUT with outcome field persists correctly
 *   2. PUT with invalid outcome value returns 400
 *   3. GET returns outcome fields
 *   4. Outcome fields are nullable — existing tasks unaffected
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { handleTaskQueueRoute } from '../task-queue.js';

const TEST_PORT = 19871;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-outcome-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

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
    title: 'Outcome test task',
    description: 'Testing outcome tagging',
    ...overrides,
  });
  assert.equal(res.status, 201);
  return JSON.parse(res.body);
}

/** Advance a task to in_progress so outcome can be set alongside completion. */
async function advanceToInProgress(taskId: string): Promise<void> {
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'assigned', assignee: 'orchestrator',
  });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'in_progress',
  });
}

describe('Orchestrator Task Outcome Tagging', { concurrency: 1 }, () => {

  describe('PUT outcome field', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('persists outcome=success on a task update', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'All done',
        outcome: 'success',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.outcome, 'success');
    });

    it('persists outcome=partial', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'Partially done',
        outcome: 'partial',
      });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).outcome, 'partial');
    });

    it('persists outcome=failed', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'failed',
        error: 'Worker crashed',
        outcome: 'failed',
      });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).outcome, 'failed');
    });

    it('persists outcome=unknown', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'Result unclear',
        outcome: 'unknown',
      });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).outcome, 'unknown');
    });

    it('persists outcome_notes alongside outcome', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'Done',
        outcome: 'success',
        outcome_notes: 'All 5 workers completed without error',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.outcome, 'success');
      assert.equal(body.outcome_notes, 'All 5 workers completed without error');
    });

    it('allows setting outcome without changing status', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        outcome: 'partial',
        outcome_notes: 'Work in progress note',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.outcome, 'partial');
      assert.equal(body.outcome_notes, 'Work in progress note');
      assert.equal(body.status, 'in_progress', 'status should not change');
    });
  });

  describe('PUT outcome validation', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns 400 for invalid outcome value', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        outcome: 'excellent',
      });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('outcome'), `error should mention outcome: ${body.error}`);
    });

    it('returns 400 for outcome=true (boolean)', async () => {
      const task = await createTask();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        outcome: true,
      });
      assert.equal(res.status, 400);
    });

    it('returns 400 for outcome=42 (number)', async () => {
      const task = await createTask();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        outcome: 42,
      });
      assert.equal(res.status, 400);
    });

    it('accepts outcome=null to clear the field', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      // First set an outcome
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, { outcome: 'partial' });

      // Then clear it
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, { outcome: null });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).outcome, null);
    });
  });

  describe('GET returns outcome fields', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('GET /tasks/:id returns outcome and outcome_notes', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'Done',
        outcome: 'success',
        outcome_notes: 'Completed cleanly',
      });

      const res = await request('GET', `/api/orchestrator/tasks/${task.id}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.outcome, 'success');
      assert.equal(body.outcome_notes, 'Completed cleanly');
    });

    it('GET /tasks (list) includes outcome in task rows', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'Done',
        outcome: 'partial',
      });

      const res = await request('GET', '/api/orchestrator/tasks');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const found = body.data.find((t: { id: string }) => t.id === task.id);
      assert.ok(found, 'task should appear in list');
      assert.equal(found.outcome, 'partial');
    });
  });

  describe('Outcome fields nullable — existing tasks unaffected', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('new tasks have outcome=null and outcome_notes=null by default', async () => {
      const task = await createTask();

      const res = await request('GET', `/api/orchestrator/tasks/${task.id}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.outcome, null, 'outcome should be null for new tasks');
      assert.equal(body.outcome_notes, null, 'outcome_notes should be null for new tasks');
    });

    it('completing a task without outcome leaves outcome null', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'Done without tagging',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.outcome, null, 'outcome should remain null when not provided');
      assert.equal(body.outcome_notes, null);
    });
  });
});
