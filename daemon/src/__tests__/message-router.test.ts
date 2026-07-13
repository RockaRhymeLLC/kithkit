/**
 * t-142, t-143, t-144: Inter-agent message router
 *
 * Tests message routing, logging, tmux injection, and worker restrictions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query, exec } from '../core/db.js';
import { handleMessagesRoute } from '../api/messages.js';
import {
  sendMessage,
  getMessages,
  getMessagesSince,
  _setTmuxInjectorForTesting,
  _clearDedupForTesting,
  WorkerRestrictionError,
} from '../agents/message-router.js';
import type { Message } from '../agents/message-router.js';

const TEST_PORT = 19880;

// ── Helpers ──────────────────────────────────────────────────

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-msgs-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleMessagesRoute(inReq, res, url.pathname, url.searchParams)
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
    _clearDedupForTesting();   // prevent dedup map from leaking between tests
    _setTmuxInjectorForTesting(null);
    server.close(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

// ── Tests ────────────────────────────────────────────────────

describe('Message sent and logged between agents (t-142)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('POST /messages sends and returns message ID', async () => {
    const res = await request('POST', '/api/messages', {
      from: 'comms',
      to: 'orchestrator',
      type: 'task',
      body: 'Research SQLite ORMs',
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.messageId === 'number', 'should return messageId');
    // Persistent agent messages are now queued for delivery, not immediately injected
    assert.equal(body.delivered, false);
    assert.ok(body.timestamp);
  });

  it('message record exists in messages table', async () => {
    sendMessage({
      from: 'comms',
      to: 'orchestrator',
      type: 'task',
      body: 'Research SQLite ORMs',
    });

    const messages = query<Message>('SELECT * FROM messages');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].from_agent, 'comms');
    assert.equal(messages[0].to_agent, 'orchestrator');
    assert.equal(messages[0].type, 'task');
    assert.equal(messages[0].body, 'Research SQLite ORMs');
    assert.ok(messages[0].created_at);
  });

  it('GET /messages?agent=orchestrator returns sent messages', async () => {
    sendMessage({
      from: 'comms',
      to: 'orchestrator',
      type: 'task',
      body: 'Research SQLite ORMs',
    });

    const res = await request('GET', '/api/messages?agent=orchestrator');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].body, 'Research SQLite ORMs');
  });

  it('messages with metadata stored correctly', () => {
    const result = sendMessage({
      from: 'comms',
      to: 'orchestrator',
      type: 'task',
      body: 'Do research',
      metadata: { priority: 'high', requestId: 'abc' },
    });

    const messages = query<Message>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(messages.length, 1);
    const meta = JSON.parse(messages[0].metadata!);
    assert.equal(meta.priority, 'high');
    assert.equal(meta.requestId, 'abc');
  });
});

describe('Message queued for delivery to persistent agents (t-143)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('persistent agent messages are queued (not immediately injected)', () => {
    const injectedMessages: { session: string; text: string }[] = [];
    _setTmuxInjectorForTesting((session, text) => {
      injectedMessages.push({ session, text });
      return true;
    });

    const result = sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Research complete',
    });

    // No direct injection — delivery task handles it
    assert.equal(injectedMessages.length, 0);
    assert.equal(result.delivered, false);

    // Message still stored in DB with processed_at = NULL (undelivered)
    const messages = query<Message>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].processed_at, null);
  });

  it('tmux injector NOT called for worker targets', () => {
    const injectedMessages: { session: string; text: string }[] = [];
    _setTmuxInjectorForTesting((session, text) => {
      injectedMessages.push({ session, text });
      return true;
    });

    sendMessage({
      from: 'orchestrator',
      to: 'worker-abc',
      type: 'task',
      body: 'Do work',
    });

    assert.equal(injectedMessages.length, 0, 'should not inject into worker tmux');
  });

  it('message stored in DB even for persistent agents', () => {
    const result = sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Research complete',
    });

    assert.equal(result.delivered, false);
    // Message should be in DB awaiting delivery
    const messages = query<Message>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, 'Research complete');
  });
});

describe('Worker messages restricted to result and error (t-144)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('worker can send result messages', async () => {
    const res = await request('POST', '/api/messages', {
      from: 'worker-123',
      to: 'orchestrator',
      type: 'result',
      body: 'Done',
    });

    assert.equal(res.status, 200);
  });

  it('worker can send error messages', async () => {
    const res = await request('POST', '/api/messages', {
      from: 'worker-123',
      to: 'orchestrator',
      type: 'error',
      body: 'Failed',
    });

    assert.equal(res.status, 200);
  });

  it('worker cannot send status messages', async () => {
    const res = await request('POST', '/api/messages', {
      from: 'worker-123',
      to: 'orchestrator',
      type: 'status',
      body: 'Still working...',
    });

    assert.equal(res.status, 403);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('result or error'));
  });

  it('worker cannot send task messages', async () => {
    const res = await request('POST', '/api/messages', {
      from: 'worker-123',
      to: 'orchestrator',
      type: 'task',
      body: 'Delegate this',
    });

    assert.equal(res.status, 403);
  });

  it('UUID-format worker IDs also restricted', () => {
    // Workers spawned by lifecycle get UUID IDs
    assert.throws(
      () => sendMessage({
        from: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        to: 'orchestrator',
        type: 'status',
        body: 'Progress update',
      }),
      WorkerRestrictionError,
    );
  });

  it('comms and orchestrator can send any type', () => {
    // Should not throw
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task' });
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'status', body: 'Status' });
    sendMessage({ from: 'orchestrator', to: 'comms', type: 'text', body: 'Hello' });

    const messages = query<Message>('SELECT * FROM messages');
    assert.equal(messages.length, 3);
  });
});

describe('getMessagesSince — since_id cursor polling (race condition fix)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns only messages with id > sinceId addressed to the agent', () => {
    const r1 = sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'First task' });
    const r2 = sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Second task' });
    const r3 = sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Third task' });

    // Seed cursor at r1 — should return r2 and r3
    const since = getMessagesSince('orchestrator', r1.messageId);
    assert.equal(since.length, 2);
    assert.equal(since[0]!.id, r2.messageId);
    assert.equal(since[1]!.id, r3.messageId);
  });

  it('returns empty array when no messages newer than sinceId', () => {
    const r1 = sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Only task' });
    const since = getMessagesSince('orchestrator', r1.messageId);
    assert.equal(since.length, 0);
  });

  it('returns all messages when sinceId is 0', () => {
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task A' });
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task B' });
    const since = getMessagesSince('orchestrator', 0);
    assert.equal(since.length, 2);
  });

  it('filters by type when provided', () => {
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task A' });
    const r2 = sendMessage({ from: 'comms', to: 'orchestrator', type: 'status', body: 'Status' });
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task B' });

    const tasksSince = getMessagesSince('orchestrator', 0, 'task');
    assert.equal(tasksSince.length, 2);
    assert.ok(tasksSince.every(m => m.type === 'task'), 'should only return task messages');

    const statusSince = getMessagesSince('orchestrator', 0, 'status');
    assert.equal(statusSince.length, 1);
    assert.equal(statusSince[0]!.id, r2.messageId);
  });

  it('only returns messages TO the specified agent', () => {
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'For orch' });
    sendMessage({ from: 'orchestrator', to: 'comms', type: 'result', body: 'For comms' });

    const orchSince = getMessagesSince('orchestrator', 0);
    assert.equal(orchSince.length, 1);
    assert.equal(orchSince[0]!.body, 'For orch');
  });

  it('works regardless of read_at or processed_at state (immune to race condition)', () => {
    const r1 = sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task' });

    // Simulate Claude (running as orchestrator) marking the message as read+processed via API —
    // this is the race condition: Claude sees the notification ping and calls GET ?unread=true,
    // which sets both processed_at and read_at before the wrapper's poll loop runs.
    const now = new Date().toISOString();
    exec('UPDATE messages SET read_at = ?, processed_at = ? WHERE id = ?',
      now, now, r1.messageId);

    // Verify it's now fully consumed
    const consumed = query<Message>('SELECT * FROM messages WHERE id = ?', r1.messageId);
    assert.equal(consumed.length, 1);
    assert.ok(consumed[0]!.read_at, 'message should be marked read');

    // getMessagesSince(r1.messageId) returns 0 — cursor is PAST r1, nothing newer
    const since = getMessagesSince('orchestrator', r1.messageId);
    assert.equal(since.length, 0);

    // A NEW message after r1 should be found regardless of read/processed state of r1
    const r2 = sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'New task' });
    const since2 = getMessagesSince('orchestrator', r1.messageId);
    assert.equal(since2.length, 1);
    assert.equal(since2[0]!.id, r2.messageId);
  });
});

describe('GET /api/messages?since_id=N API endpoint', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns messages with id > since_id for the agent', async () => {
    const r1 = sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'First' });
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Second' });

    const res = await request('GET', `/api/messages?agent=orchestrator&since_id=${r1.messageId}`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].body, 'Second');
  });

  it('returns 400 for non-numeric since_id', async () => {
    const res = await request('GET', '/api/messages?agent=orchestrator&since_id=abc');
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('since_id'));
  });

  it('since_id=0 returns all messages', async () => {
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task A' });
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task B' });

    const res = await request('GET', '/api/messages?agent=orchestrator&since_id=0');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 2);
  });

  it('since_id with type filter returns only matching messages', async () => {
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'Task' });
    sendMessage({ from: 'comms', to: 'orchestrator', type: 'status', body: 'Status' });

    const res = await request('GET', '/api/messages?agent=orchestrator&since_id=0&type=task');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].type, 'task');
  });
});

describe('Messages API validation', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('requires from field', async () => {
    const res = await request('POST', '/api/messages', {
      to: 'orchestrator',
      body: 'Hello',
    });
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('from'));
  });

  it('requires to field', async () => {
    const res = await request('POST', '/api/messages', {
      from: 'comms',
      body: 'Hello',
    });
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('to'));
  });

  it('requires body field', async () => {
    const res = await request('POST', '/api/messages', {
      from: 'comms',
      to: 'orchestrator',
    });
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('body'));
  });

  it('GET /messages requires agent parameter', async () => {
    const res = await request('GET', '/api/messages');
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('agent'));
  });
});

describe('Direct channel — immediate delivery for persistent agents', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('direct=true injects immediately and sets processed_at', () => {
    const injected: { session: string; text: string }[] = [];
    _setTmuxInjectorForTesting((session, text) => {
      injected.push({ session, text });
      return true;
    });

    const result = sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'text',
      body: 'Quick question about the spec',
      direct: true,
    });

    assert.equal(result.delivered, true);
    assert.equal(injected.length, 1);
    assert.ok(injected[0].text.includes('Quick question about the spec'));

    // Message should be marked as processed
    const messages = query<Message>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].processed_at, 'processed_at should be set for direct delivery');
  });

  it('direct=true falls back to queued delivery if injection fails', () => {
    _setTmuxInjectorForTesting(() => false);

    const result = sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'text',
      body: 'Session is down',
      direct: true,
    });

    // Falls back to queued delivery
    assert.equal(result.delivered, false);

    // processed_at should NOT be set (needs to be delivered by scheduler)
    const messages = query<Message>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].processed_at, null);
  });

  it('direct=false (default) queues for scheduler delivery', () => {
    const injected: { session: string; text: string }[] = [];
    _setTmuxInjectorForTesting((session, text) => {
      injected.push({ session, text });
      return true;
    });

    const result = sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Research complete',
    });

    // No immediate injection
    assert.equal(injected.length, 0);
    assert.equal(result.delivered, false);
  });

  it('direct=true has no effect for worker targets', () => {
    const injected: { session: string; text: string }[] = [];
    _setTmuxInjectorForTesting((session, text) => {
      injected.push({ session, text });
      return true;
    });

    const result = sendMessage({
      from: 'orchestrator',
      to: 'worker-abc',
      type: 'task',
      body: 'Do work',
      direct: true,
    });

    // Workers pull their own messages — no injection
    assert.equal(injected.length, 0);
    assert.equal(result.delivered, true);
  });

  it('POST /api/messages with direct=true passes through to sendMessage', async () => {
    const injected: { session: string; text: string }[] = [];
    _setTmuxInjectorForTesting((session, text) => {
      injected.push({ session, text });
      return true;
    });

    const res = await request('POST', '/api/messages', {
      from: 'orchestrator',
      to: 'comms',
      type: 'text',
      body: 'Direct via API',
      direct: true,
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.delivered, true);
    assert.equal(injected.length, 1);
  });
});

describe('Auto-complete orchestrator task on result message (#70)', () => {
  beforeEach(setup);
  afterEach(teardown);

  function createTask(id: string, status: string, createdAt: string): void {
    exec(
      `INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      id, `Task ${id}`, status, createdAt, createdAt,
    );
  }

  function addWorker(taskId: string, workerId: string): void {
    exec(
      `INSERT INTO orchestrator_task_workers (task_id, worker_id, role, assigned_at)
       VALUES (?, ?, NULL, '2026-01-01T00:00:00Z')`,
      taskId, workerId,
    );
  }

  // ── Tests that verify the NEW task_id-required auto-complete behavior ────

  it('without metadata.task_id, no task is auto-completed (FIFO removed, #266 fix)', () => {
    // Both tasks exist and are active, but no task_id is supplied.
    // The old FIFO path would have completed one of them; the new code must not.
    createTask('task-a', 'in_progress', '2026-01-01T00:00:00Z');
    createTask('task-b', 'pending',     '2026-01-02T00:00:00Z');
    addWorker('task-a', 'worker-a');

    sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Result without task_id',
      // no metadata — old FIFO would have completed task-a here
    });

    const taskA = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-a');
    const taskB = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-b');
    assert.equal(taskA[0]!.status, 'in_progress', 'task-a must remain in_progress — no FIFO auto-complete');
    assert.equal(taskB[0]!.status, 'pending',     'task-b must remain pending');
  });

  it('matches by metadata.task_id when provided (and task has work evidence)', () => {
    createTask('task-a', 'in_progress', '2026-01-01T00:00:00Z');
    createTask('task-b', 'pending',     '2026-01-02T00:00:00Z');
    // Add a worker to task-b so it passes the invariant guard
    addWorker('task-b', 'worker-b');

    sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Result for task B',
      metadata: { task_id: 'task-b', completion: true },
    });

    const taskA = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-a');
    const taskB = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-b');
    assert.equal(taskA[0]!.status, 'in_progress', 'task A should remain in_progress');
    assert.equal(taskB[0]!.status, 'completed',   'task B should be completed via metadata match');
  });

  it('without metadata.task_id and no in_progress task, still no auto-complete (#266 fix)', () => {
    // Old FIFO "fallback" would have completed the oldest pending task.
    // New code must not complete any task when task_id is absent.
    createTask('task-old', 'pending', '2026-01-01T00:00:00Z');
    createTask('task-new', 'pending', '2026-01-02T00:00:00Z');
    addWorker('task-old', 'worker-old');

    sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Some result',
      // no metadata — old FIFO would have completed task-old
    });

    const taskOld = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-old');
    const taskNew = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-new');
    assert.equal(taskOld[0]!.status, 'pending', 'task-old must remain pending — no FIFO auto-complete');
    assert.equal(taskNew[0]!.status, 'pending', 'task-new must remain pending');
  });

  it('result message with task_id does not affect already-completed tasks', () => {
    createTask('task-done',   'completed',  '2026-01-01T00:00:00Z');
    createTask('task-active', 'in_progress','2026-01-02T00:00:00Z');
    addWorker('task-active', 'worker-active');

    // Send result targeting task-active
    sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'New result',
      metadata: { task_id: 'task-active', completion: true },
    });

    const taskDone   = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-done');
    const taskActive = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-active');
    assert.equal(taskDone[0]!.status,   'completed', 'already-completed task must not be re-completed');
    assert.equal(taskActive[0]!.status, 'completed', 'task-active should be completed');
  });
});

describe('Regression #266 — task.result race: correct body written, no cross-contamination', () => {
  beforeEach(setup);
  afterEach(teardown);

  function createTask(id: string, status: string): void {
    const ts = '2026-01-01T00:00:00Z';
    exec(
      `INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      id, `Task ${id}`, status, ts, ts,
    );
  }

  function addWorker(taskId: string, workerId: string): void {
    exec(
      `INSERT INTO orchestrator_task_workers (task_id, worker_id, role, assigned_at)
       VALUES (?, ?, NULL, '2026-01-01T00:00:00Z')`,
      taskId, workerId,
    );
  }

  it('result with task_id writes correct body; unrelated message without task_id leaves other tasks intact', () => {
    // Arrange: two active tasks
    createTask('task-real',  'in_progress');
    createTask('task-other', 'in_progress');
    addWorker('task-real',  'worker-real');
    addWorker('task-other', 'worker-other');

    // Act: send the real result for task-real (with task_id and completion flag)
    sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Correct synthesis for task-real',
      metadata: { task_id: 'task-real', completion: true },
    });

    // Act: send a ghost/unrelated message without task_id (simulates the race scenario)
    sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Ghost-bug alert — should NOT end up in any task.result',
      // no metadata.task_id — old FIFO code would have written this to task-other
    });

    const real  = query<{ status: string; result: string }>(
      'SELECT status, result FROM orchestrator_tasks WHERE id = ?', 'task-real',
    );
    const other = query<{ status: string; result: string }>(
      'SELECT status, result FROM orchestrator_tasks WHERE id = ?', 'task-other',
    );

    // task-real must be completed with the CORRECT result body
    assert.equal(real[0]!.status, 'completed', 'task-real must be completed');
    assert.equal(real[0]!.result, 'Correct synthesis for task-real',
      'task-real.result must contain the correct body, not the ghost message');

    // task-other must NOT be touched by the ghost message
    assert.equal(other[0]!.status, 'in_progress',
      'task-other must remain in_progress — ghost message must not cross-contaminate');
    assert.equal(other[0]!.result, null,
      'task-other.result must be null — ghost message must not write into it');
  });

  it('invariant guard: task with no workers and no activity is not auto-completed (#266)', () => {
    // A phantom task with zero workers and zero activity must never be auto-completed,
    // even when a result message names it explicitly via task_id.
    const ts = '2026-01-01T00:00:00Z';
    exec(
      `INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at)
       VALUES ('ghost-task', 'Ghost Task', 'in_progress', 0, ?, ?)`,
      ts, ts,
    );
    // Intentionally no workers and no activity inserted.

    sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Should be rejected by invariant',
      metadata: { task_id: 'ghost-task', completion: true },
    });

    const task = query<{ status: string; result: string }>(
      'SELECT status, result FROM orchestrator_tasks WHERE id = ?', 'ghost-task',
    );
    assert.equal(task[0]!.status, 'in_progress',
      'ghost task (no workers, no activity) must not be auto-completed');
    assert.equal(task[0]!.result, null,
      'ghost task result must remain null');
  });
});

describe('GET /api/messages — offset/order/limit pagination (todo 2821)', () => {
  beforeEach(setup);
  afterEach(teardown);

  // Insert N messages directly with strictly increasing created_at timestamps
  // so ordering assertions are deterministic (avoids relying on SQLite's
  // unspecified tie-break behavior when created_at collides at 1s resolution).
  function seedMessages(count: number, type = 'text'): void {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < count; i++) {
      const ts = new Date(base + i * 1000).toISOString();
      exec(
        `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        'comms', 'agent-x', type, `Message ${i}`, ts,
      );
    }
  }

  it('default unchanged: no limit/offset/order returns all rows, ASC', async () => {
    seedMessages(5);
    const res = await request('GET', '/api/messages?agent=agent-x');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 5);
    assert.equal(body.data[0].body, 'Message 0');
    assert.equal(body.data[4].body, 'Message 4');
  });

  it('limit honored: limit=3 on a 5-row fixture returns 3 oldest, ASC', async () => {
    seedMessages(5);
    const res = await request('GET', '/api/messages?agent=agent-x&limit=3');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 3);
    assert.deepEqual(body.data.map((m: { body: string }) => m.body), ['Message 0', 'Message 1', 'Message 2']);
  });

  it('limit clamped: limit=99999 is capped at 500 even with 510 rows available', async () => {
    seedMessages(510);
    const res = await request('GET', '/api/messages?agent=agent-x&limit=99999');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 500, 'limit must be capped at 500');
  });

  it('offset full paging: pages through a 10-row fixture with no gaps or overlaps', async () => {
    seedMessages(10);
    const seen: string[] = [];
    for (const offset of [0, 3, 6, 9]) {
      const res = await request('GET', `/api/messages?agent=agent-x&limit=3&offset=${offset}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      seen.push(...body.data.map((m: { body: string }) => m.body));
    }
    assert.equal(seen.length, 10, 'all 10 rows must appear exactly once across pages');
    assert.deepEqual(seen, Array.from({ length: 10 }, (_, i) => `Message ${i}`));
  });

  it('out-of-range offset returns an empty array with HTTP 200', async () => {
    seedMessages(5);
    const res = await request('GET', '/api/messages?agent=agent-x&offset=5000');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.data, []);
  });

  it('order=desc returns the same rows reversed, newest first', async () => {
    seedMessages(5);
    const res = await request('GET', '/api/messages?agent=agent-x&order=desc');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 5);
    assert.equal(body.data[0].body, 'Message 4');
    assert.equal(body.data[4].body, 'Message 0');
  });

  it('invalid order value silently falls back to asc, HTTP 200', async () => {
    seedMessages(3);
    const res = await request('GET', '/api/messages?agent=agent-x&order=sideways');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data[0].body, 'Message 0');
    assert.equal(body.data[2].body, 'Message 2');
  });

  it('combined type+limit+offset+order — no interaction bugs', async () => {
    seedMessages(6, 'task');
    // Noise row of a different type, addressed from agent-x to a third party
    // (not to agent-x) — must be excluded by the type filter.
    exec(
      `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      'agent-x', 'someone-else', 'status', 'Noise', '2026-01-01T00:00:03.500Z',
    );

    const res = await request(
      'GET',
      '/api/messages?agent=agent-x&type=task&limit=2&offset=2&order=desc',
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 2);
    assert.ok(body.data.every((m: { type: string }) => m.type === 'task'), 'must only return task-type rows');
    // 6 task rows (Message 0..5) DESC = [5,4,3,2,1,0] -> offset 2 -> [3,2]
    assert.deepEqual(body.data.map((m: { body: string }) => m.body), ['Message 3', 'Message 2']);
  });

  it('order value is case-insensitive: order=DESC (uppercase) behaves like desc', async () => {
    seedMessages(5);
    const res = await request('GET', '/api/messages?agent=agent-x&order=DESC');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 5);
    assert.equal(body.data[0].body, 'Message 4');
    assert.equal(body.data[4].body, 'Message 0');
  });

  it('limit=0 is explicitly clamped to 1 row (documented, not "no limit")', async () => {
    seedMessages(5);
    const res = await request('GET', '/api/messages?agent=agent-x&limit=0');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1, 'limit=0 must clamp to exactly 1 row, matching Math.max(limitRaw, 1)');
    assert.equal(body.data[0].body, 'Message 0');
  });
});

describe('GET /api/messages — default limit 200 / hard cap 500 (todo 2833)', () => {
  beforeEach(setup);
  afterEach(teardown);

  function seedMessages(count: number, type = 'text'): void {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < count; i++) {
      const ts = new Date(base + i * 1000).toISOString();
      exec(
        `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        'comms', 'agent-x', type, `Message ${i}`, ts,
      );
    }
  }

  it('omitted limit defaults to 200 rows out of 300 available', async () => {
    seedMessages(300);
    const res = await request('GET', '/api/messages?agent=agent-x');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 200, 'omitted limit must default to 200');
    assert.equal(body.data[0].body, 'Message 0');
    assert.equal(body.data[199].body, 'Message 199');
  });

  it('explicit limit=500 is honored in full on a 510-row fixture', async () => {
    seedMessages(510);
    const res = await request('GET', '/api/messages?agent=agent-x&limit=500');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 500, 'explicit limit=500 must return exactly 500 rows');
  });

  it('explicit limit=9999 is clamped to the 500 hard cap', async () => {
    seedMessages(510);
    const res = await request('GET', '/api/messages?agent=agent-x&limit=9999');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 500, 'limit=9999 must be clamped to 500');
  });

  it('explicit limit continues to compose with order/offset after the default-limit change', async () => {
    seedMessages(10);
    const res = await request('GET', '/api/messages?agent=agent-x&limit=3&offset=2&order=desc');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 3);
    // 10 rows DESC = [9,8,...,0] -> offset 2 -> [7,6,5]
    assert.deepEqual(body.data.map((m: { body: string }) => m.body), ['Message 7', 'Message 6', 'Message 5']);
  });
});

describe('GET /api/messages — WHERE clause OR/AND precedence (todo 2835)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('type filter excludes wrong-type rows addressed TO the agent (regression)', async () => {
    // Row 1: addressed TO agent-x, correct type ('task') — must be included.
    exec(
      `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      'comms', 'agent-x', 'task', 'Wanted task', '2026-01-01T00:00:00.000Z',
    );
    // Row 2 (noise): addressed TO agent-x, WRONG type ('status'). Without the
    // parenthesized (to_agent = ? OR from_agent = ?) AND type = ?, SQL's
    // AND-binds-tighter-than-OR precedence lets this leak through the type
    // filter because it matches the bare `to_agent = ?` OR-branch.
    exec(
      `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      'comms', 'agent-x', 'status', 'Noise: wrong type addressed to agent-x', '2026-01-01T00:00:01.000Z',
    );

    const res = await request('GET', '/api/messages?agent=agent-x&type=task');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1, 'wrong-type row addressed TO agent-x must be excluded');
    assert.equal(body.data[0].body, 'Wanted task');
    assert.ok(
      body.data.every((m: { type: string }) => m.type === 'task'),
      'every returned row must match the requested type',
    );
  });
});

// ── since= filter mutation-kill tests ─────────────────────────────────────────
//
// Seed layout (used across tests):
//   old1: 2026-03-01  body='Old March'
//   old2: 2026-06-01  body='Old June'
//   new1: 2026-07-10  body='New July-10'
//   new2: 2026-07-12  body='New July-12'
//
// Cutoff: since=2026-07-01 → should return ONLY new1 + new2
// Mutation-kill: removing the `AND created_at >= ?` clause from getMessages()
// causes since= to be ignored — all 4 rows return → assertions on count=2
// and the absence of the 'Old' rows both go RED.

describe("GET /api/messages — since= date filter (FIX 2)", () => {
  beforeEach(setup);
  afterEach(teardown);

  function seedSinceFixture(): void {
    const rows: [string, string][] = [
      ['2026-03-01T00:00:00.000Z', 'Old March'],
      ['2026-06-01T00:00:00.000Z', 'Old June'],
      ['2026-07-10T00:00:00.000Z', 'New July-10'],
      ['2026-07-12T00:00:00.000Z', 'New July-12'],
    ];
    for (const [ts, body] of rows) {
      exec(
        `INSERT INTO messages (from_agent, to_agent, type, body, created_at) VALUES (?, ?, ?, ?, ?)`,
        'comms', 'agent-q', 'text', body, ts,
      );
    }
  }

  it('since= returns only rows at or after the cutoff (count + identity, not vacuous)', async () => {
    seedSinceFixture();
    // Cutoff lands between June and July rows.
    const res = await request('GET', '/api/messages?agent=agent-q&since=2026-07-01');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);

    // Count check — fails (returns 4) if since= is ignored.
    assert.equal(body.data.length, 2, 'since= must exclude rows before 2026-07-01');

    // Identity check — fails if any pre-cutoff row leaks through.
    const bodies: string[] = body.data.map((m: { body: string }) => m.body);
    assert.ok(!bodies.includes('Old March'),  'Old March must be filtered out by since=');
    assert.ok(!bodies.includes('Old June'),   'Old June must be filtered out by since=');
    assert.ok(bodies.includes('New July-10'), 'New July-10 must be in results');
    assert.ok(bodies.includes('New July-12'), 'New July-12 must be in results');
  });

  it('since= with full ISO timestamp filters inclusively at the exact boundary', async () => {
    seedSinceFixture();
    // since= exactly equals old2's timestamp — old2 must be included (>=, not >).
    const res = await request('GET', '/api/messages?agent=agent-q&since=2026-06-01T00:00:00.000Z');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);

    // Expect: old2 (June 01), new1, new2 — NOT old1 (March).
    assert.equal(body.data.length, 3, 'boundary row must be included (>= not >)');
    const bodies: string[] = body.data.map((m: { body: string }) => m.body);
    assert.ok(!bodies.includes('Old March'), 'Old March must be excluded');
    assert.ok(bodies.includes('Old June'),   'Old June must be included (exact boundary)');
  });

  it('since= composes correctly with order=desc (newest-first ordering of filtered rows)', async () => {
    seedSinceFixture();
    const res = await request('GET', '/api/messages?agent=agent-q&since=2026-07-01&order=desc');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.data.length, 2, 'since= must still filter with order=desc');
    // DESC order: July-12 first, July-10 second.
    assert.equal(body.data[0].body, 'New July-12', 'first row must be newest (July-12)');
    assert.equal(body.data[1].body, 'New July-10', 'second row must be next (July-10)');
  });

  it('invalid since= (non-date string) returns 400', async () => {
    const res = await request('GET', '/api/messages?agent=agent-q&since=not-a-date');
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(
      typeof body.error === 'string' && body.error.toLowerCase().includes('since'),
      'error message must reference the since param',
    );
  });

  it('since= with no matching rows returns empty array (not an error)', async () => {
    seedSinceFixture();
    // Far-future cutoff — no messages exist after this date.
    const res = await request('GET', '/api/messages?agent=agent-q&since=2030-01-01');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.data, [], 'no-match since= must return empty array with HTTP 200');
  });

  it('back-compat: default (no since= param) still returns all rows oldest-first', async () => {
    seedSinceFixture();
    const res = await request('GET', '/api/messages?agent=agent-q');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);

    // All 4 rows, ASC order — unchanged from before this fix.
    assert.equal(body.data.length, 4, 'omitting since= must return all rows (back-compat)');
    assert.equal(body.data[0].body, 'Old March',   'first row must be oldest (back-compat ASC order)');
    assert.equal(body.data[3].body, 'New July-12', 'last row must be newest (back-compat ASC order)');
  });
});
