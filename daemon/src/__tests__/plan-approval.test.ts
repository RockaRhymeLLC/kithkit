/**
 * Plan approval workflow tests — orchestrator plan submission, approval, and rejection.
 *
 * Tests the submit-plan, approve-plan, and reject-plan routes and their
 * effect on task status and plan_status fields.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query } from '../core/db.js';
import { handleTaskQueueRoute } from '../api/task-queue.js';
import { _setEvaluateTaskFnForTesting } from '../api/task-queue.js';

const TEST_PORT = 19871;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-planapproval-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Disable retro evaluation for tests
  _setEvaluateTaskFnForTesting(async () => {});

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

/** Helper: advance a task to in_progress state. */
async function advanceToInProgress(taskId: string): Promise<void> {
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'assigned', assignee: 'orchestrator',
  });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'in_progress',
  });
}

describe('Plan Approval Workflow', { concurrency: 1 }, () => {

  // ── submit-plan ────────────────────────────────────────────

  describe('submit-plan', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('succeeds when task is in_progress', async () => {
      const task = await createTask({ title: 'Plan me' });
      await advanceToInProgress(task.id as string);

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'Step 1: Do X\nStep 2: Do Y\nStep 3: Verify',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'awaiting_approval');
      assert.equal(body.plan_status, 'submitted');
      assert.ok(body.plan_submitted_at, 'should have plan_submitted_at');
      assert.equal(body.plan, 'Step 1: Do X\nStep 2: Do Y\nStep 3: Verify');
    });

    it('fails when task is pending (not in_progress)', async () => {
      const task = await createTask();

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'My plan',
      });
      assert.equal(res.status, 409);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('in_progress'), `error: ${body.error}`);
    });

    it('fails when task is assigned (not in_progress)', async () => {
      const task = await createTask();
      await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'assigned', assignee: 'orchestrator',
      });

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'My plan',
      });
      assert.equal(res.status, 409);
    });

    it('fails when plan field is missing', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {});
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('plan'), `error: ${body.error}`);
    });

    it('logs activity on plan submission', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'My detailed plan',
      });

      const actRes = await request('GET', `/api/orchestrator/tasks/${task.id}/activity`);
      const actBody = JSON.parse(actRes.body);
      const planLog = actBody.data.find(
        (a: { stage: string }) => a.stage === 'plan_submitted',
      );
      assert.ok(planLog, 'should have logged plan_submitted activity');
    });

    it('returns 404 for nonexistent task', async () => {
      const res = await request('POST', '/api/orchestrator/tasks/no-such-id/submit-plan', {
        plan: 'A plan',
      });
      assert.equal(res.status, 404);
    });
  });

  // ── approve-plan ───────────────────────────────────────────

  describe('approve-plan', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('succeeds when awaiting_approval + plan_status=submitted', async () => {
      const task = await createTask({ title: 'Approve me' });
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'The plan',
      });

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/approve-plan`, {});
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'in_progress');
      assert.equal(body.plan_status, 'approved');
      assert.ok(body.plan_approved_at, 'should have plan_approved_at');
    });

    it('fails when task is not awaiting_approval', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/approve-plan`, {});
      assert.equal(res.status, 409);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('awaiting_approval'), `error: ${body.error}`);
    });

    it('fails when task is pending', async () => {
      const task = await createTask();

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/approve-plan`, {});
      assert.equal(res.status, 409);
    });

    it('logs activity on approval', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'The plan',
      });
      await request('POST', `/api/orchestrator/tasks/${task.id}/approve-plan`, {});

      const actRes = await request('GET', `/api/orchestrator/tasks/${task.id}/activity`);
      const actBody = JSON.parse(actRes.body);
      const approvalLog = actBody.data.find(
        (a: { stage: string }) => a.stage === 'plan_approved',
      );
      assert.ok(approvalLog, 'should have logged plan_approved activity');
    });

    it('sends orchestrator notification on approval', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'The plan',
      });
      await request('POST', `/api/orchestrator/tasks/${task.id}/approve-plan`, {});

      const msgs = query<{ to_agent: string; body: string }>(
        `SELECT to_agent, body FROM messages WHERE to_agent = 'orchestrator'`,
      );
      assert.ok(msgs.length > 0, 'should have sent message to orchestrator');
      const approveMsg = msgs.find(m => m.body.includes('Plan approved'));
      assert.ok(approveMsg, 'message body should mention plan approved');
    });
  });

  // ── reject-plan ────────────────────────────────────────────

  describe('reject-plan', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('succeeds with a reason', async () => {
      const task = await createTask({ title: 'Reject me' });
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'The plan',
      });

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/reject-plan`, {
        reason: 'Plan is too vague',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'in_progress');
      assert.equal(body.plan_status, 'rejected');
      assert.equal(body.plan_rejected_reason, 'Plan is too vague');
    });

    it('succeeds without a reason, defaults to "No reason provided"', async () => {
      const task = await createTask({ title: 'Reject no reason' });
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'The plan',
      });

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/reject-plan`, {});
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'in_progress');
      assert.equal(body.plan_status, 'rejected');
      assert.equal(body.plan_rejected_reason, 'No reason provided');
    });

    it('fails when task is not awaiting_approval', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/reject-plan`, {
        reason: 'Bad plan',
      });
      assert.equal(res.status, 409);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('awaiting_approval'), `error: ${body.error}`);
    });

    it('logs activity on rejection with reason', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'The plan',
      });
      await request('POST', `/api/orchestrator/tasks/${task.id}/reject-plan`, {
        reason: 'Not detailed enough',
      });

      const actRes = await request('GET', `/api/orchestrator/tasks/${task.id}/activity`);
      const actBody = JSON.parse(actRes.body);
      const rejectionLog = actBody.data.find(
        (a: { stage: string; message: string }) => a.stage === 'plan_rejected',
      );
      assert.ok(rejectionLog, 'should have logged plan_rejected activity');
      assert.ok(rejectionLog.message.includes('Not detailed enough'), `message: ${rejectionLog.message}`);
    });

    it('sends orchestrator notification on rejection', async () => {
      const task = await createTask();
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'The plan',
      });
      await request('POST', `/api/orchestrator/tasks/${task.id}/reject-plan`, {
        reason: 'Needs more detail',
      });

      const msgs = query<{ to_agent: string; body: string }>(
        `SELECT to_agent, body FROM messages WHERE to_agent = 'orchestrator' AND body LIKE '%rejected%'`,
      );
      assert.ok(msgs.length > 0, 'should have sent rejection message to orchestrator');
      assert.ok(msgs[0]!.body.includes('Needs more detail'), 'message should include rejection reason');
    });
  });

  // ── State machine transitions ──────────────────────────────

  describe('State machine transitions', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('in_progress → awaiting_approval → in_progress (approved)', async () => {
      const task = await createTask({ title: 'Full approval cycle' });

      // Start at pending
      let detail = JSON.parse((await request('GET', `/api/orchestrator/tasks/${task.id}`)).body);
      assert.equal(detail.status, 'pending');

      // Move to assigned then in_progress
      await advanceToInProgress(task.id as string);
      detail = JSON.parse((await request('GET', `/api/orchestrator/tasks/${task.id}`)).body);
      assert.equal(detail.status, 'in_progress');

      // Submit plan → awaiting_approval
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'My full plan',
      });
      detail = JSON.parse((await request('GET', `/api/orchestrator/tasks/${task.id}`)).body);
      assert.equal(detail.status, 'awaiting_approval');
      assert.equal(detail.plan_status, 'submitted');

      // Approve → in_progress
      await request('POST', `/api/orchestrator/tasks/${task.id}/approve-plan`, {});
      detail = JSON.parse((await request('GET', `/api/orchestrator/tasks/${task.id}`)).body);
      assert.equal(detail.status, 'in_progress');
      assert.equal(detail.plan_status, 'approved');
    });

    it('in_progress → awaiting_approval → in_progress (rejected)', async () => {
      const task = await createTask({ title: 'Full rejection cycle' });

      await advanceToInProgress(task.id as string);

      // Submit plan → awaiting_approval
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'My plan to be rejected',
      });
      let detail = JSON.parse((await request('GET', `/api/orchestrator/tasks/${task.id}`)).body);
      assert.equal(detail.status, 'awaiting_approval');

      // Reject → in_progress
      await request('POST', `/api/orchestrator/tasks/${task.id}/reject-plan`, {
        reason: 'Too vague',
      });
      detail = JSON.parse((await request('GET', `/api/orchestrator/tasks/${task.id}`)).body);
      assert.equal(detail.status, 'in_progress');
      assert.equal(detail.plan_status, 'rejected');
      assert.equal(detail.plan_rejected_reason, 'Too vague');
    });

    it('awaiting_approval can be cancelled', async () => {
      const task = await createTask({ title: 'Cancel while awaiting' });
      await advanceToInProgress(task.id as string);

      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'My plan',
      });

      // Cancel via PUT (using valid transition awaiting_approval → cancelled)
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'cancelled',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'cancelled');
    });

    it('awaiting_approval status is included in list filters', async () => {
      const task = await createTask({ title: 'Awaiting list test' });
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'My plan',
      });

      const res = await request('GET', '/api/orchestrator/tasks?status=awaiting_approval');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].title, 'Awaiting list test');
    });

    it('cannot submit plan twice without re-entering in_progress', async () => {
      const task = await createTask({ title: 'Double submit' });
      await advanceToInProgress(task.id as string);
      await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'First plan',
      });

      // Task is now awaiting_approval — cannot submit another plan
      const res = await request('POST', `/api/orchestrator/tasks/${task.id}/submit-plan`, {
        plan: 'Second plan',
      });
      assert.equal(res.status, 409, 'Should reject plan submission from awaiting_approval status');
    });
  });
});
