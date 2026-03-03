/**
 * Unified A2A Handler — 9 test cases.
 *
 * Tests the HTTP route handler for POST /api/a2a/send,
 * including body parsing, method filtering, error mapping, and response format.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { handleA2ARoute, setA2ARouter, ERROR_CODE_TO_HTTP } from '../a2a/handler.js';
import type { UnifiedA2ARouter } from '../a2a/router.js';
import type { A2ASendResult } from '../a2a/types.js';

// ── Helpers ──────────────────────────────────────────────────

function createFakeRequest(method: string, pathname: string, body?: unknown): http.IncomingMessage {
  const readable = new Readable();
  if (body !== undefined) {
    readable.push(Buffer.from(JSON.stringify(body)));
  }
  readable.push(null);
  return Object.assign(readable, {
    method,
    url: pathname,
    headers: { 'content-type': 'application/json' },
  }) as unknown as http.IncomingMessage;
}

function createInvalidJsonRequest(method: string, pathname: string): http.IncomingMessage {
  const readable = new Readable();
  readable.push(Buffer.from('not json'));
  readable.push(null);
  return Object.assign(readable, {
    method,
    url: pathname,
    headers: { 'content-type': 'application/json' },
  }) as unknown as http.IncomingMessage;
}

function createFakeResponse(): {
  res: http.ServerResponse;
  getResult: () => { status: number; body: any };
} {
  let statusCode = 0;
  let bodyData = '';
  let headersWritten = false;

  const fakeRes = {
    statusCode: 0,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      statusCode = status;
      headersWritten = true;
      return fakeRes;
    },
    setHeader() { return fakeRes; },
    end(data?: string) {
      if (data) bodyData = data;
    },
  };

  return {
    res: fakeRes as unknown as http.ServerResponse,
    getResult: () => ({
      status: statusCode,
      body: bodyData ? JSON.parse(bodyData) : null,
    }),
  };
}

// ── Mock Router ──────────────────────────────────────────────

function createMockRouter(sendResult: A2ASendResult): UnifiedA2ARouter {
  return {
    send: async (_body: unknown) => sendResult,
    validate: (_body: unknown) => null,
    resolvePeer: (_name: string) => ({ qualifiedName: _name }),
  } as unknown as UnifiedA2ARouter;
}

// ── Tests ────────────────────────────────────────────────────

describe('A2A Handler', () => {
  afterEach(() => {
    // Reset router to null
    setA2ARouter(null as any);
  });

  it('1. POST /api/a2a/send valid body -> 200', async () => {
    const mockRouter = createMockRouter({
      ok: true,
      messageId: 'test-uuid',
      target: 'bmo',
      targetType: 'dm',
      route: 'lan',
      status: 'delivered',
      attempts: [{ route: 'lan', status: 'success', latencyMs: 10 }],
      timestamp: new Date().toISOString(),
    });
    setA2ARouter(mockRouter);

    const req = createFakeRequest('POST', '/api/a2a/send', {
      to: 'bmo',
      payload: { type: 'text', text: 'hello' },
    });
    const { res, getResult } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/send', new URLSearchParams());

    assert.equal(handled, true);
    assert.equal(getResult().status, 200);
    assert.equal(getResult().body.ok, true);
  });

  it('2. POST /api/a2a/send invalid JSON -> 400', async () => {
    const mockRouter = createMockRouter({
      ok: true,
      messageId: 'x',
      target: 'bmo',
      targetType: 'dm',
      route: 'lan',
      status: 'delivered',
      attempts: [],
      timestamp: new Date().toISOString(),
    });
    setA2ARouter(mockRouter);

    const req = createInvalidJsonRequest('POST', '/api/a2a/send');
    const { res, getResult } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/send', new URLSearchParams());

    assert.equal(handled, true);
    assert.equal(getResult().status, 400);
    assert.equal(getResult().body.code, 'INVALID_REQUEST');
  });

  it('3. POST /api/a2a/send missing payload -> 400', async () => {
    // Router returns validation error for missing payload
    const mockRouter = {
      send: async (_body: unknown) => ({
        ok: false as const,
        error: '"payload" is required and must be an object',
        code: 'INVALID_REQUEST' as const,
        timestamp: new Date().toISOString(),
      }),
    } as unknown as UnifiedA2ARouter;
    setA2ARouter(mockRouter);

    const req = createFakeRequest('POST', '/api/a2a/send', {
      to: 'bmo',
    });
    const { res, getResult } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/send', new URLSearchParams());

    assert.equal(handled, true);
    assert.equal(getResult().status, 400);
    assert.equal(getResult().body.code, 'INVALID_REQUEST');
  });

  it('4. POST /api/a2a/send both to+group -> 400', async () => {
    const mockRouter = {
      send: async (_body: unknown) => ({
        ok: false as const,
        error: 'Specify exactly one of "to" or "group", not both',
        code: 'INVALID_TARGET' as const,
        timestamp: new Date().toISOString(),
      }),
    } as unknown as UnifiedA2ARouter;
    setA2ARouter(mockRouter);

    const req = createFakeRequest('POST', '/api/a2a/send', {
      to: 'bmo',
      group: 'home-agents',
      payload: { type: 'text' },
    });
    const { res, getResult } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/send', new URLSearchParams());

    assert.equal(handled, true);
    assert.equal(getResult().status, 400);
    assert.equal(getResult().body.code, 'INVALID_TARGET');
  });

  it('5. GET /api/a2a/send -> returns false', async () => {
    const mockRouter = createMockRouter({
      ok: true,
      messageId: 'x',
      target: 'bmo',
      targetType: 'dm',
      route: 'lan',
      status: 'delivered',
      attempts: [],
      timestamp: new Date().toISOString(),
    });
    setA2ARouter(mockRouter);

    const req = createFakeRequest('GET', '/api/a2a/send');
    const { res } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/send', new URLSearchParams());

    assert.equal(handled, false);
  });

  it('6. POST /api/a2a/other -> returns false', async () => {
    const mockRouter = createMockRouter({
      ok: true,
      messageId: 'x',
      target: 'bmo',
      targetType: 'dm',
      route: 'lan',
      status: 'delivered',
      attempts: [],
      timestamp: new Date().toISOString(),
    });
    setA2ARouter(mockRouter);

    const req = createFakeRequest('POST', '/api/a2a/other');
    const { res } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/other', new URLSearchParams());

    assert.equal(handled, false);
  });

  it('7. Delivery failure -> 502', async () => {
    const mockRouter = {
      send: async (_body: unknown) => ({
        ok: false as const,
        error: 'All delivery routes failed',
        code: 'DELIVERY_FAILED' as const,
        attempts: [
          { route: 'lan', status: 'failed', error: 'Timeout', latencyMs: 3000 },
        ],
        timestamp: new Date().toISOString(),
      }),
    } as unknown as UnifiedA2ARouter;
    setA2ARouter(mockRouter);

    const req = createFakeRequest('POST', '/api/a2a/send', {
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
    });
    const { res, getResult } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/send', new URLSearchParams());

    assert.equal(handled, true);
    assert.equal(getResult().status, 502);
    assert.equal(getResult().body.code, 'DELIVERY_FAILED');
  });

  it('8. Relay unavailable -> 503', async () => {
    const mockRouter = {
      send: async (_body: unknown) => ({
        ok: false as const,
        error: 'Network SDK not initialized',
        code: 'RELAY_UNAVAILABLE' as const,
        timestamp: new Date().toISOString(),
      }),
    } as unknown as UnifiedA2ARouter;
    setA2ARouter(mockRouter);

    const req = createFakeRequest('POST', '/api/a2a/send', {
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });
    const { res, getResult } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/send', new URLSearchParams());

    assert.equal(handled, true);
    assert.equal(getResult().status, 503);
    assert.equal(getResult().body.code, 'RELAY_UNAVAILABLE');
  });

  it('9. Response includes timestamp', async () => {
    const ts = new Date().toISOString();
    const mockRouter = createMockRouter({
      ok: true,
      messageId: 'test-uuid',
      target: 'bmo',
      targetType: 'dm',
      route: 'lan',
      status: 'delivered',
      attempts: [{ route: 'lan', status: 'success', latencyMs: 5 }],
      timestamp: ts,
    });
    setA2ARouter(mockRouter);

    const req = createFakeRequest('POST', '/api/a2a/send', {
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
    });
    const { res, getResult } = createFakeResponse();

    const handled = await handleA2ARoute(req, res, '/api/a2a/send', new URLSearchParams());

    assert.equal(handled, true);
    assert.ok(getResult().body.timestamp, 'Response should include timestamp');
    assert.equal(typeof getResult().body.timestamp, 'string');
  });
});
