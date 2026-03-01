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

  it('direct=true injects immediately and sets processed_at and read_at', () => {
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

    // Message should be marked as processed AND read (full content was displayed)
    const messages = query<Message>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].processed_at, 'processed_at should be set for direct delivery');
    assert.ok(messages[0].read_at, 'read_at should be set — content was already displayed in tmux');
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
