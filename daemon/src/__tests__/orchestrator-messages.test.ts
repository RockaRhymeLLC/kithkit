/**
 * Orchestrator Messages API tests.
 *
 * Tests GET (list) and POST (send with pre-filled from) under
 * /api/orchestrator/messages.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query } from '../core/db.js';
import { handleOrchestratorMessagesRoute } from '../api/orchestrator-messages.js';
import { sendMessage, _setTmuxInjectorForTesting, _clearDedupForTesting } from '../agents/message-router.js';
import type { Message } from '../agents/message-router.js';

const TEST_PORT = 19891;

// Suppress tmux injection during tests
_setTmuxInjectorForTesting(() => true);

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orch-msgs-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  _clearDedupForTesting();

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);

    // Buffer body before routing (mirrors main.ts behavior)
    const bodyChunks: Buffer[] = [];
    inReq.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    inReq.on('end', () => {
      (inReq as unknown as Record<string, unknown>)._rawBody = Buffer.concat(bodyChunks);
      res.setHeader('X-Timestamp', new Date().toISOString());
      handleOrchestratorMessagesRoute(inReq, res, url.pathname, url.searchParams)
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
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _clearDedupForTesting();
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

// ── Tests ─────────────────────────────────────────────────────

describe('Orchestrator Messages API', { concurrency: 1 }, () => {

  describe('GET /api/orchestrator/messages', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns empty array when no messages exist', async () => {
      const res = await request('GET', '/api/orchestrator/messages');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data), 'data should be an array');
      assert.equal(body.data.length, 0);
      assert.ok(body.timestamp, 'Should have timestamp');
    });

    it('returns messages for orchestrator', async () => {
      // Send a message to orchestrator using the message router directly
      sendMessage({
        from: 'comms',
        to: 'orchestrator',
        type: 'task',
        body: 'Please do task X',
      });

      const res = await request('GET', '/api/orchestrator/messages');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.length >= 1, `Expected at least 1 message, got ${body.data.length}`);
      const msg = body.data.find((m: Message) => m.body === 'Please do task X');
      assert.ok(msg, 'Should find the test message');
      assert.equal(msg.from_agent, 'comms');
      assert.equal(msg.to_agent, 'orchestrator');
    });

    it('also includes messages sent from orchestrator', async () => {
      sendMessage({
        from: 'orchestrator',
        to: 'comms',
        type: 'result',
        body: 'Task completed',
      });

      const res = await request('GET', '/api/orchestrator/messages');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const msg = body.data.find((m: Message) => m.body === 'Task completed');
      assert.ok(msg, 'Should find messages from orchestrator too');
    });

    it('filters messages by type', async () => {
      _clearDedupForTesting();
      sendMessage({ from: 'comms', to: 'orchestrator', type: 'task', body: 'FilterTest task message' });
      _clearDedupForTesting();
      sendMessage({ from: 'comms', to: 'orchestrator', type: 'text', body: 'FilterTest text message' });

      const res = await request('GET', '/api/orchestrator/messages?type=task');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const types = body.data.map((m: Message) => m.type);
      assert.ok(types.every((t: string) => t === 'task'), `Expected only task types, got: ${types.join(',')}`);
    });

    it('respects limit parameter', async () => {
      // Insert 5 messages
      for (let i = 0; i < 5; i++) {
        sendMessage({
          from: 'comms',
          to: 'orchestrator',
          type: 'task',
          body: `Task ${i} message that is unique enough to not dedup`,
          // Use metadata to ensure uniqueness and avoid dedup window
        });
        _clearDedupForTesting();
      }

      const res = await request('GET', '/api/orchestrator/messages?limit=2');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.length <= 2, `Expected at most 2 messages, got ${body.data.length}`);
    });
  });

  describe('POST /api/orchestrator/messages', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('sends a message with orchestrator as sender', async () => {
      const res = await request('POST', '/api/orchestrator/messages', {
        to: 'comms',
        type: 'result',
        body: 'Task completed successfully',
      });
      assert.equal(res.status, 200, `body: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.ok(typeof body.messageId === 'number', 'Should return messageId');
      assert.ok(typeof body.delivered === 'boolean', 'Should return delivered');
      assert.ok(body.timestamp, 'Should have timestamp');

      // Verify the message was stored with orchestrator as from_agent
      const msgs = query<{ from_agent: string; to_agent: string; type: string; body: string }>(
        'SELECT from_agent, to_agent, type, body FROM messages WHERE id = ?',
        body.messageId,
      );
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0]!.from_agent, 'orchestrator', 'from_agent should always be orchestrator');
      assert.equal(msgs[0]!.to_agent, 'comms');
      assert.equal(msgs[0]!.type, 'result');
      assert.equal(msgs[0]!.body, 'Task completed successfully');
    });

    it('defaults to text type when not specified', async () => {
      const res = await request('POST', '/api/orchestrator/messages', {
        to: 'comms',
        body: 'Hello comms',
      });
      assert.equal(res.status, 200, `body: ${res.body}`);
      const body = JSON.parse(res.body);

      const msgs = query<{ type: string }>(
        'SELECT type FROM messages WHERE id = ?',
        body.messageId,
      );
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0]!.type, 'text');
    });

    it('stores metadata when provided', async () => {
      const res = await request('POST', '/api/orchestrator/messages', {
        to: 'comms',
        type: 'result',
        body: 'Done',
        metadata: { task_id: 'abc-123', worker_count: 2 },
      });
      assert.equal(res.status, 200, `body: ${res.body}`);
      const body = JSON.parse(res.body);

      const msgs = query<{ metadata: string }>(
        'SELECT metadata FROM messages WHERE id = ?',
        body.messageId,
      );
      assert.equal(msgs.length, 1);
      const meta = JSON.parse(msgs[0]!.metadata) as Record<string, unknown>;
      assert.equal(meta.task_id, 'abc-123');
      assert.equal(meta.worker_count, 2);
    });

    it('returns 400 when to is missing', async () => {
      const res = await request('POST', '/api/orchestrator/messages', {
        body: 'Hello',
      });
      assert.equal(res.status, 400);
      const b = JSON.parse(res.body);
      assert.ok(b.error.includes('to'));
    });

    it('returns 400 when body is missing', async () => {
      const res = await request('POST', '/api/orchestrator/messages', {
        to: 'comms',
      });
      assert.equal(res.status, 400);
      const b = JSON.parse(res.body);
      assert.ok(b.error.includes('body'));
    });

    it('returns 400 for invalid JSON body', async () => {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const opts: http.RequestOptions = {
          host: '127.0.0.1',
          port: TEST_PORT,
          path: '/api/orchestrator/messages',
          method: 'POST',
          timeout: 5000,
          headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        };
        const r = http.request(opts, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        r.on('error', reject);
        r.write('{invalid json');
        r.end();
      });
      assert.equal(res.status, 400);
      const b = JSON.parse(res.body);
      assert.ok(b.error.includes('JSON'));
    });
  });

  describe('Route non-match', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns false (404) for unrelated paths', async () => {
      const res = await request('GET', '/api/agents');
      assert.equal(res.status, 404);
    });

    it('returns false (404) for /api/orchestrator/tasks', async () => {
      const res = await request('GET', '/api/orchestrator/tasks');
      assert.equal(res.status, 404);
    });
  });
});
