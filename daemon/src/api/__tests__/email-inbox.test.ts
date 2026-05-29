/**
 * Email Inbox API route-layer tests.
 *
 * Verifies call wiring and response shape using a mock EmailProvider.
 * Does NOT test the JMAP provider internals — those are covered by their
 * own tests. This file only tests the HTTP route handler behaviour.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleEmailRoute, setEmailProvider, type EmailProvider } from '../email.js';
import type { EmailMessage } from '../../extensions/comms/adapters/email/jmap-provider.js';

const TEST_PORT = 19878;

// ── HTTP helper ───────────────────────────────────────────────

function request(
  method: string,
  urlPath: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: { 'Connection': 'close' },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: { _raw: data } as Record<string, unknown> });
        }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

// ── Mock provider factory ─────────────────────────────────────

interface MockProvider extends EmailProvider {
  calls: { method: string; args: unknown[] }[];
  configured: boolean;
  messages: EmailMessage[];
  shouldThrow: string | null;
}

function createMock(overrides?: Partial<MockProvider>): MockProvider {
  const mock: MockProvider = {
    calls: [],
    configured: true,
    messages: [
      {
        id: 'msg1',
        subject: 'Hello',
        from: 'alice@example.com',
        date: '2026-05-27T10:00:00Z',
        isRead: false,
        preview: 'Hi there',
      },
    ],
    shouldThrow: null,

    async isConfigured() {
      mock.calls.push({ method: 'isConfigured', args: [] });
      return mock.configured;
    },

    async listInbox(limit) {
      mock.calls.push({ method: 'listInbox', args: [limit] });
      if (mock.shouldThrow) throw new Error(mock.shouldThrow);
      return mock.messages.slice(0, limit);
    },

    async readEmail(id) {
      mock.calls.push({ method: 'readEmail', args: [id] });
      if (mock.shouldThrow) throw new Error(mock.shouldThrow);
      return mock.messages.find(m => m.id === id) ?? null;
    },

    async searchEmails(query, limit) {
      mock.calls.push({ method: 'searchEmails', args: [query, limit] });
      if (mock.shouldThrow) throw new Error(mock.shouldThrow);
      return mock.messages.filter(m => m.subject.includes(query)).slice(0, limit);
    },

    ...overrides,
  };
  return mock;
}

// ── Test server helpers ───────────────────────────────────────

let server: http.Server;

function startServer(): Promise<void> {
  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://127.0.0.1:${TEST_PORT}`);

    // Buffer body (mirrors main.ts pattern)
    const bodyChunks: Buffer[] = [];
    inReq.on('data', (c: Buffer) => bodyChunks.push(c));
    inReq.on('end', () => {
      (inReq as unknown as Record<string, unknown>)._rawBody = Buffer.concat(bodyChunks);

      handleEmailRoute(inReq, res, url.pathname, url.searchParams)
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
        })
        .catch((err: Error) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
    });
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function stopServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => { if (err) reject(err); else resolve(); });
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe('Email Inbox API', { concurrency: 1 }, () => {

  beforeEach(async () => {
    await startServer();
  });

  afterEach(async () => {
    setEmailProvider(null);
    await stopServer();
  });

  // ── GET /api/email/inbox ──────────────────────────────────

  describe('GET /api/email/inbox', () => {

    it('returns inbox list with correct shape', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox');
      assert.equal(status, 200);

      const data = body.data as unknown[];
      assert.ok(Array.isArray(data), 'data should be an array');
      assert.equal(data.length, 1);

      const item = data[0] as Record<string, unknown>;
      assert.equal(item.id, 'msg1');
      assert.equal(item.from, 'alice@example.com');
      assert.equal(item.subject, 'Hello');
      assert.equal(item.snippet, 'Hi there');
      assert.equal(item.received_at, '2026-05-27T10:00:00Z');
      assert.equal(item.is_read, false);
      assert.ok('timestamp' in body, 'response should include timestamp');
    });

    it('passes limit param to provider', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      await request('GET', '/api/email/inbox?limit=5');

      const call = mock.calls.find(c => c.method === 'listInbox');
      assert.ok(call, 'listInbox should have been called');
      assert.equal(call.args[0], 5);
    });

    it('uses default limit of 20 when not specified', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      await request('GET', '/api/email/inbox');

      const call = mock.calls.find(c => c.method === 'listInbox');
      assert.ok(call, 'listInbox should have been called');
      assert.equal(call.args[0], 20);
    });

    it('returns 503 when provider not configured', async () => {
      const mock = createMock({ configured: false });
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox');
      assert.equal(status, 503);
      assert.ok(typeof body.error === 'string', 'error message expected');
      assert.ok((body.error as string).includes('keychain'), 'error should mention keychain');
    });

    it('returns 502 when JMAP provider throws', async () => {
      const mock = createMock({ shouldThrow: 'JMAP request failed: 500' });
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox');
      assert.equal(status, 502);
      assert.ok(typeof body.error === 'string');
      assert.ok((body.error as string).includes('JMAP provider error'));
    });

    it('calls isConfigured before listInbox', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      await request('GET', '/api/email/inbox');

      const methods = mock.calls.map(c => c.method);
      assert.ok(methods.indexOf('isConfigured') < methods.indexOf('listInbox'));
    });

  });

  // ── GET /api/email/inbox/:id ──────────────────────────────

  describe('GET /api/email/inbox/:id', () => {

    it('returns full message with body field', async () => {
      const mock = createMock();
      mock.messages[0]!.body = 'Full email body text';
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox/msg1');
      assert.equal(status, 200);
      assert.equal(body.id, 'msg1');
      assert.equal(body.body, 'Full email body text');
      assert.equal(body.from, 'alice@example.com');
      assert.equal(body.subject, 'Hello');
    });

    it('passes the message id to readEmail', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      await request('GET', '/api/email/inbox/msg1');

      const call = mock.calls.find(c => c.method === 'readEmail');
      assert.ok(call, 'readEmail should have been called');
      assert.equal(call.args[0], 'msg1');
    });

    it('returns 404 when message not found', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox/nonexistent');
      assert.equal(status, 404);
      assert.ok(typeof body.error === 'string');
    });

    it('returns 503 when provider not configured', async () => {
      const mock = createMock({ configured: false });
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox/msg1');
      assert.equal(status, 503);
      assert.ok((body.error as string).includes('keychain'));
    });

    it('returns 502 when JMAP provider throws', async () => {
      const mock = createMock({ shouldThrow: 'JMAP session failed: 401' });
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox/msg1');
      assert.equal(status, 502);
      assert.ok((body.error as string).includes('JMAP provider error'));
    });

  });

  // ── GET /api/email/inbox/search ───────────────────────────

  describe('GET /api/email/inbox/search', () => {

    it('returns search results', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox/search?q=Hello');
      assert.equal(status, 200);

      const data = body.data as unknown[];
      assert.ok(Array.isArray(data));
    });

    it('passes query and limit to searchEmails', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      await request('GET', '/api/email/inbox/search?q=invoice&limit=10');

      const call = mock.calls.find(c => c.method === 'searchEmails');
      assert.ok(call, 'searchEmails should have been called');
      assert.equal(call.args[0], 'invoice');
      assert.equal(call.args[1], 10);
    });

    it('returns 400 when q param is missing', async () => {
      const mock = createMock();
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox/search');
      assert.equal(status, 400);
      assert.ok((body.error as string).includes('q parameter'));
    });

    it('returns 503 when provider not configured', async () => {
      const mock = createMock({ configured: false });
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox/search?q=test');
      assert.equal(status, 503);
      assert.ok((body.error as string).includes('keychain'));
    });

    it('returns 502 when JMAP provider throws', async () => {
      const mock = createMock({ shouldThrow: 'JMAP request failed: 503' });
      setEmailProvider(mock);

      const { status, body } = await request('GET', '/api/email/inbox/search?q=test');
      assert.equal(status, 502);
      assert.ok((body.error as string).includes('JMAP provider error'));
    });

  });

  // ── Route non-matching ────────────────────────────────────

  describe('non-email paths', () => {

    it('returns 404 for /api/other paths', async () => {
      setEmailProvider(createMock());

      const { status } = await request('GET', '/api/other/path');
      assert.equal(status, 404);
    });

    it('returns 404 for /api/email/other paths', async () => {
      setEmailProvider(createMock());

      const { status } = await request('GET', '/api/email/other');
      assert.equal(status, 404);
    });

  });

});
