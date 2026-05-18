/**
 * Tests for the acknowledged_at guard on tasks with source='human'.
 *
 * The guard enforces that only the comms agent may set acknowledged_at on tasks
 * created via POST /api/orchestrator/escalate (which carry source='human').
 * Callers without X-Agent: comms are rejected with 403.
 *
 * The existing terminal-status guard (acknowledged_at requires a terminal status)
 * takes precedence: a non-terminal task returns 409 regardless of X-Agent header.
 *
 * Tests:
 *   1. No X-Agent header, source=human → 403
 *   2. X-Agent: orchestrator, source=human → 403
 *   3. X-Agent: comms, source=human → 200, acknowledged_at stored, GET reflects it
 *   4. No X-Agent header, source=orchestrator → 200 (guard doesn't fire)
 *   5. No X-Agent header, source=NULL (legacy) → 200 (guard doesn't fire)
 *   6. X-Agent: comms, source=human, non-terminal task → 409 (terminal guard wins first)
 *
 * Note on task creation: tasks with a specific source value are inserted directly
 * into the DB via exec() rather than through the API, because POST /api/orchestrator/tasks
 * does not accept a `source` field (source is set by the handler based on call path).
 * This is the cleanest approach for unit tests — no mock of the escalate endpoint needed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase, _resetDbForTesting, exec } from '../../core/db.js';
import { handleTaskQueueRoute, _setEvaluateTaskFnForTesting } from '../task-queue.js';

const TEST_PORT = 19874;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
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
        ...extraHeaders,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-ack-guard-'));
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

/**
 * Insert a task directly into the DB with a specific source value.
 * Returns the task external_id (UUID). Task starts in 'pending' state.
 * Uses the unified `tasks` table (migration 024).
 */
function insertTask(source: string | null): string {
  const id = randomUUID();
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO tasks (external_id, kind, title, status, priority, source, created_at, updated_at)
     VALUES (?, 'orchestrator', ?, 'pending', 'medium', ?, ?, ?)`,
    id,
    'Human source guard test task',
    source,
    ts,
    ts,
  );
  return id;
}

/** Advance a task to completed status via the API state machine. */
async function completeTask(taskId: string): Promise<void> {
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'assigned', assignee: 'orchestrator',
  });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'in_progress',
  });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
    status: 'completed', result: 'Done',
  });
}

// ── Tests ──────────────────────────────────────────────────────

describe('acknowledged_at guard — source=human tasks', { concurrency: 1 }, () => {

  describe('Test 1: no X-Agent header on source=human task returns 403', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('PUT acknowledged_at without X-Agent header is rejected with 403', async () => {
      const taskId = insertTask('human');
      await completeTask(taskId);

      const res = await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
        acknowledged_at: new Date().toISOString(),
      });
      assert.equal(res.status, 403, `Expected 403, got: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('comms'), `Error should mention comms: ${body.error}`);
      assert.equal(body.caller, null, 'caller should be null when no X-Agent header');
    });
  });

  describe('Test 2: X-Agent: orchestrator on source=human task returns 403', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('PUT acknowledged_at with X-Agent: orchestrator is rejected with 403', async () => {
      const taskId = insertTask('human');
      await completeTask(taskId);

      const res = await request(
        'PUT',
        `/api/orchestrator/tasks/${taskId}`,
        { acknowledged_at: new Date().toISOString() },
        { 'X-Agent': 'orchestrator' },
      );
      assert.equal(res.status, 403, `Expected 403, got: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.equal(body.caller, 'orchestrator', 'caller should be reflected in response');
    });
  });

  describe('Test 3: X-Agent: comms on source=human task returns 200', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('PUT acknowledged_at with X-Agent: comms succeeds and is stored', async () => {
      const taskId = insertTask('human');
      await completeTask(taskId);

      const ackTime = new Date().toISOString();
      const res = await request(
        'PUT',
        `/api/orchestrator/tasks/${taskId}`,
        { comms_outcome: 'accepted', acknowledged_at: ackTime },
        { 'X-Agent': 'comms' },
      );
      assert.equal(res.status, 200, `Expected 200, got: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.equal(body.acknowledged_at, ackTime, 'acknowledged_at should be stored');
      assert.equal(body.comms_outcome, 'accepted');

      // Verify GET reflects the stored value
      const get = await request('GET', `/api/orchestrator/tasks/${taskId}`);
      assert.equal(get.status, 200);
      const getBody = JSON.parse(get.body);
      assert.equal(getBody.acknowledged_at, ackTime, 'GET should return the stored acknowledged_at');
    });
  });

  // Note: 'orchestrator' is a reserved source enum value but no production code path
  // currently emits it (escalate hardcodes 'human'; POST /api/orchestrator/tasks omits source).
  // No test for source='orchestrator' — it is dead code today.

  describe('Test 5: no X-Agent header on source=NULL (legacy) task returns 200', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('guard does not fire for source=NULL — acknowledged_at accepted without X-Agent', async () => {
      const taskId = insertTask(null);
      await completeTask(taskId);

      const ackTime = new Date().toISOString();
      const res = await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
        comms_outcome: 'accepted',
        acknowledged_at: ackTime,
      });
      assert.equal(res.status, 200, `Expected 200 for source=NULL, got: ${res.body}`);
      assert.equal(JSON.parse(res.body).acknowledged_at, ackTime);
    });
  });

  describe('Test 6: X-Agent: comms, source=human, non-terminal task returns 409 (terminal guard wins)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('terminal-status guard fires before source guard — 409, not 403', async () => {
      const taskId = insertTask('human');
      // Leave task in non-terminal state (in_progress)
      await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
        status: 'assigned', assignee: 'orchestrator',
      });
      await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
        status: 'in_progress',
      });

      const res = await request(
        'PUT',
        `/api/orchestrator/tasks/${taskId}`,
        { acknowledged_at: new Date().toISOString() },
        { 'X-Agent': 'comms' },
      );
      assert.equal(res.status, 409, `Expected 409 (terminal guard), got: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.ok(
        body.error.includes('acknowledged_at') || body.error.includes('terminal'),
        `Error should mention terminal constraint, got: ${body.error}`,
      );
    });
  });

});
