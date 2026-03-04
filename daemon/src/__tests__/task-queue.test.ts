/**
 * Task Queue API tests — orchestrator task management.
 *
 * Tests task CRUD, state machine transitions, activity log,
 * worker assignment, and status/assignee validation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query } from '../core/db.js';
import { handleTaskQueueRoute, _setInjectMessageForTesting, _resetInjectMessageForTesting } from '../api/task-queue.js';

// Mock injectMessage to prevent real tmux injections during tests
_setInjectMessageForTesting(() => true);

const TEST_PORT = 19870;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-taskq-'));
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

/** Helper: create a task and return the parsed body. */
async function createTask(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await request('POST', '/api/orchestrator/tasks', {
    title: 'Test task',
    description: 'Do the thing',
    ...overrides,
  });
  assert.equal(res.status, 201);
  return JSON.parse(res.body);
}

describe('Task Queue API', { concurrency: 1 }, () => {

  // ── Task CRUD ──────────────────────────────────────────────

  describe('Task CRUD', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates a task with defaults', async () => {
      const task = await createTask();
      assert.ok(task.id, 'Should have a UUID id');
      assert.equal(task.title, 'Test task');
      assert.equal(task.description, 'Do the thing');
      assert.equal(task.status, 'pending');
      assert.equal(task.assignee, null);
      assert.equal(task.priority, 0);
      assert.ok(task.created_at);
      assert.ok(task.updated_at);
      assert.ok(task.timestamp, 'Response should include timestamp');
    });

    it('creates a task with priority', async () => {
      const task = await createTask({ priority: 2 });
      assert.equal(task.priority, 2);
    });

    it('rejects invalid priority', async () => {
      const res = await request('POST', '/api/orchestrator/tasks', { title: 'Bad', priority: 5 });
      assert.equal(res.status, 400);
      assert.ok(JSON.parse(res.body).error.includes('priority'));
    });

    it('rejects missing title', async () => {
      const res = await request('POST', '/api/orchestrator/tasks', { description: 'no title' });
      assert.equal(res.status, 400);
    });

    it('lists tasks ordered by priority DESC, created_at ASC', async () => {
      await createTask({ title: 'Low', priority: 0 });
      await createTask({ title: 'Urgent', priority: 2 });
      await createTask({ title: 'High', priority: 1 });

      const res = await request('GET', '/api/orchestrator/tasks');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 3);
      assert.equal(body.data[0].title, 'Urgent');
      assert.equal(body.data[1].title, 'High');
      assert.equal(body.data[2].title, 'Low');
    });

    it('filters tasks by status', async () => {
      const t1 = await createTask({ title: 'Pending' });
      await createTask({ title: 'Also pending' });

      // Move t1 to assigned
      await request('PUT', `/api/orchestrator/tasks/${t1.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });

      const res = await request('GET', '/api/orchestrator/tasks?status=pending');
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].title, 'Also pending');
    });

    it('filters tasks by multiple statuses', async () => {
      const t1 = await createTask({ title: 'Pending' });
      await request('PUT', `/api/orchestrator/tasks/${t1.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await createTask({ title: 'Also pending' });

      const res = await request('GET', '/api/orchestrator/tasks?status=pending,assigned');
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2);
    });

    it('gets task detail with workers and activity', async () => {
      const task = await createTask();

      const res = await request('GET', `/api/orchestrator/tasks/${task.id}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, task.id);
      assert.ok(Array.isArray(body.workers));
      assert.ok(Array.isArray(body.activity));
    });

    it('returns 404 for nonexistent task', async () => {
      const res = await request('GET', '/api/orchestrator/tasks/nonexistent-uuid');
      assert.equal(res.status, 404);
    });
  });

  // ── State Machine ──────────────────────────────────────────

  describe('State Machine', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('transitions pending → assigned', async () => {
      const task = await createTask();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'assigned');
      assert.equal(body.assignee, 'orchestrator');
      assert.ok(body.assigned_at);
    });

    it('transitions assigned → in_progress', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'in_progress');
      assert.ok(body.started_at);
    });

    it('transitions in_progress → completed', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed', result: 'All done',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'completed');
      assert.equal(body.result, 'All done');
      assert.ok(body.completed_at);
    });

    it('transitions in_progress → failed', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'failed', error: 'Something went wrong',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'failed');
      assert.equal(body.error, 'Something went wrong');
    });

    it('rejects invalid transition pending → completed', async () => {
      const task = await createTask();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
      });
      assert.equal(res.status, 409);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('cannot transition'));
    });

    it('rejects invalid transition pending → in_progress', async () => {
      const task = await createTask();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      assert.equal(res.status, 409);
    });

    it('rejects updates to completed tasks', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed', result: 'Done',
      });

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'pending',
      });
      assert.equal(res.status, 409);
      assert.ok(JSON.parse(res.body).error.includes('Cannot update completed'));
    });

    it('allows assigned → pending (return to queue)', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'pending',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'pending');
      assert.equal(body.assignee, null, 'Assignee should be cleared on return to pending');
    });
  });

  // ── Assignee/Status Validation ─────────────────────────────

  describe('Assignee/Status Validation', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('rejects assigned status without assignee', async () => {
      const task = await createTask();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned',
      });
      assert.equal(res.status, 400);
      assert.ok(JSON.parse(res.body).error.includes('assignee'));
    });

    it('allows setting assignee without changing status', async () => {
      const task = await createTask();
      // This should fail because pending + assignee is invalid
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        assignee: 'orchestrator',
      });
      assert.equal(res.status, 400);
      assert.ok(JSON.parse(res.body).error.includes('pending'));
    });

    it('allows setting both status and assignee in one request', async () => {
      const task = await createTask();
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned',
        assignee: 'worker-abc-123',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'assigned');
      assert.equal(body.assignee, 'worker-abc-123');
    });
  });

  // ── Activity Log ───────────────────────────────────────────

  describe('Activity Log', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('posts a progress activity entry', async () => {
      const task = await createTask();
      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/activity`, {
        type: 'progress',
        stage: 'spawning_workers',
        message: 'Spawned 2 research workers',
        agent: 'orchestrator',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.type, 'progress');
      assert.equal(body.stage, 'spawning_workers');
      assert.equal(body.agent, 'orchestrator');
    });

    it('posts a note activity entry', async () => {
      const task = await createTask();
      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/activity`, {
        type: 'note',
        message: 'This depends on the API reference',
        agent: 'orchestrator',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.type, 'note');
      assert.equal(body.stage, null);
    });

    it('rejects activity with missing message', async () => {
      const task = await createTask();
      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/activity`, {
        type: 'progress',
        agent: 'orchestrator',
      });
      assert.equal(res.status, 400);
    });

    it('rejects activity with invalid type', async () => {
      const task = await createTask();
      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/activity`, {
        type: 'invalid',
        message: 'Test',
        agent: 'orchestrator',
      });
      assert.equal(res.status, 400);
    });

    it('gets activity log with pagination', async () => {
      const task = await createTask();

      // Post 5 activity entries
      for (let i = 0; i < 5; i++) {
        await request('POST', `/api/orchestrator/tasks/${task.id}/activity`, {
          type: 'note',
          message: `Entry ${i}`,
          agent: 'orchestrator',
        });
      }

      // Get with limit
      const res = await request('GET', `/api/orchestrator/tasks/${task.id}/activity?limit=2&offset=0`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2);
      assert.equal(body.total, 5);
      assert.equal(body.data[0].message, 'Entry 0');

      // Get with offset
      const res2 = await request('GET', `/api/orchestrator/tasks/${task.id}/activity?limit=2&offset=2`);
      const body2 = JSON.parse(res2.body);
      assert.equal(body2.data.length, 2);
      assert.equal(body2.data[0].message, 'Entry 2');
    });

    it('returns 404 for activity on nonexistent task', async () => {
      const res = await request('GET', '/api/orchestrator/tasks/bad-id/activity');
      assert.equal(res.status, 404);
    });
  });

  // ── Worker Assignment ──────────────────────────────────────

  describe('Worker Assignment', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('assigns a worker to a task', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/workers`, {
        worker_id: 'worker-abc-123',
        role: 'research',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.worker_id, 'worker-abc-123');
      assert.equal(body.role, 'research');
    });

    it('rejects duplicate worker assignment', async () => {
      const task = await createTask();
      await request('POST', `/api/orchestrator/tasks/${task.id}/workers`, {
        worker_id: 'worker-abc-123',
      });
      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/workers`, {
        worker_id: 'worker-abc-123',
      });
      assert.equal(res.status, 409);
    });

    it('rejects worker assignment to completed task', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed', result: 'Done',
      });

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/workers`, {
        worker_id: 'worker-abc-123',
      });
      assert.equal(res.status, 409);
    });

    it('shows workers in task detail', async () => {
      const task = await createTask();
      await request('POST', `/api/orchestrator/tasks/${task.id}/workers`, {
        worker_id: 'worker-1',
        role: 'research',
      });
      await request('POST', `/api/orchestrator/tasks/${task.id}/workers`, {
        worker_id: 'worker-2',
        role: 'coding',
      });

      const res = await request('GET', `/api/orchestrator/tasks/${task.id}`);
      const body = JSON.parse(res.body);
      assert.equal(body.workers.length, 2);
      assert.equal(body.workers[0].role, 'research');
      assert.equal(body.workers[1].role, 'coding');
    });
  });

  // ── Rapid-fire Escalation (Success Criterion 1) ────────────

  describe('Rapid-fire task creation', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('queues 5 tasks in rapid succession without loss', async () => {
      const results = await Promise.all([
        createTask({ title: 'Task 1' }),
        createTask({ title: 'Task 2' }),
        createTask({ title: 'Task 3' }),
        createTask({ title: 'Task 4' }),
        createTask({ title: 'Task 5' }),
      ]);

      assert.equal(results.length, 5);
      const ids = new Set(results.map(r => r.id));
      assert.equal(ids.size, 5, 'All tasks should have unique IDs');

      const listRes = await request('GET', '/api/orchestrator/tasks?status=pending');
      const body = JSON.parse(listRes.body);
      assert.equal(body.data.length, 5);
    });
  });

  // ── Auto-activity on status change (Fix 4) ─────────────────

  describe('Auto-activity log on status change', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('auto-logs activity when task transitions to assigned', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });

      const actRes = await request('GET', `/api/orchestrator/tasks/${task.id}/activity`);
      const actBody = JSON.parse(actRes.body);
      const statusChanges = actBody.data.filter((a: { stage: string }) => a.stage === 'status_change');
      assert.ok(statusChanges.length > 0, 'should have auto-logged a status_change activity');
      assert.ok(statusChanges[0].message.includes('assigned'), `message: ${statusChanges[0].message}`);
    });

    it('auto-logs activity with result when task completes', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed', result: 'All tasks completed successfully',
      });

      const actRes = await request('GET', `/api/orchestrator/tasks/${task.id}/activity`);
      const actBody = JSON.parse(actRes.body);
      const completionLog = actBody.data.find(
        (a: { stage: string; message: string }) => a.stage === 'status_change' && a.message.includes('completed'),
      );
      assert.ok(completionLog, 'should have auto-logged completion activity');
      assert.ok(completionLog.message.includes('All tasks completed'), `message: ${completionLog.message}`);
    });

    it('auto-logs activity with error when task fails', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'failed', error: 'Worker crashed unexpectedly',
      });

      const actRes = await request('GET', `/api/orchestrator/tasks/${task.id}/activity`);
      const actBody = JSON.parse(actRes.body);
      const failureLog = actBody.data.find(
        (a: { stage: string; message: string }) => a.stage === 'status_change' && a.message.includes('failed'),
      );
      assert.ok(failureLog, 'should have auto-logged failure activity');
      assert.ok(failureLog.message.includes('Worker crashed'), `message: ${failureLog.message}`);
    });
  });

  // ── Auto-notification to comms on completion (Fix 2) ───────

  describe('Auto-notification to comms on task completion', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('sends a message to comms when task completes', async () => {
      const task = await createTask({ title: 'Deploy feature X' });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed', result: 'Feature deployed to staging',
      });

      // Check the messages table for auto-notification
      const msgs = query<{ from_agent: string; to_agent: string; type: string; body: string }>(
        `SELECT from_agent, to_agent, type, body FROM messages WHERE to_agent = 'comms' AND from_agent = 'daemon'`,
      );
      assert.ok(msgs.length > 0, 'should have sent a message to comms');
      const completionMsg = msgs.find(m => m.body.includes('Deploy feature X'));
      assert.ok(completionMsg, 'message should include task title');
      assert.ok(completionMsg!.body.includes('Feature deployed to staging'), 'message should include result');
      assert.equal(completionMsg!.type, 'result');
    });

    it('sends a message to comms when task fails', async () => {
      const task = await createTask({ title: 'Run integration tests' });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'failed', error: 'Tests timed out',
      });

      const msgs = query<{ from_agent: string; to_agent: string; type: string; body: string }>(
        `SELECT from_agent, to_agent, type, body FROM messages WHERE to_agent = 'comms' AND from_agent = 'daemon'`,
      );
      assert.ok(msgs.length > 0, 'should have sent a message to comms on failure');
      const failureMsg = msgs.find(m => m.body.includes('Run integration tests'));
      assert.ok(failureMsg, 'message should include task title');
      assert.ok(failureMsg!.body.includes('Tests timed out'), 'message should include error detail');
    });

    it('does not send comms message on non-terminal status transitions', async () => {
      const task = await createTask({ title: 'Background work' });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'in_progress',
      });

      // No completion — check no messages sent
      const msgs = query<{ id: number }>(
        `SELECT id FROM messages WHERE to_agent = 'comms' AND from_agent = 'daemon'`,
      );
      assert.equal(msgs.length, 0, 'should NOT send comms message for non-terminal transitions');
    });
  });
});
