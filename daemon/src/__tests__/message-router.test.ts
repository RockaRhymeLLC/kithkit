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
import { openDatabase, _resetDbForTesting, query } from '../core/db.js';
import { handleMessagesRoute } from '../api/messages.js';
import {
  sendMessage,
  getMessages,
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
    assert.equal(body.delivered, true);
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

describe('Message injected into persistent agent tmux (t-143)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('tmux injector called for persistent agents', () => {
    const injectedMessages: { session: string; text: string }[] = [];
    _setTmuxInjectorForTesting((session, text) => {
      injectedMessages.push({ session, text });
      return true;
    });

    sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Research complete',
    });

    assert.equal(injectedMessages.length, 1);
    assert.equal(injectedMessages[0].session, 'comms');
    assert.ok(injectedMessages[0].text.includes('Research complete'));
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

  it('message logged even when tmux injection fails', () => {
    _setTmuxInjectorForTesting(() => false);

    const result = sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Research complete',
    });

    assert.equal(result.delivered, false);
    // But message should still be in DB
    const messages = query<Message>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(messages.length, 1);
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
