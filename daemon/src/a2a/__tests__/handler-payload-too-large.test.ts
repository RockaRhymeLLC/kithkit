/**
 * Unit tests for POST /api/a2a/send — PAYLOAD_TOO_LARGE maps to HTTP 413.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { handleA2ARoute, setA2ARouter } from '../handler.js';
import { UnifiedA2ARouter, MAX_A2A_TEXT_LENGTH } from '../router.js';
import type { RouterDeps } from '../router.js';

// ── Mock helpers ──────────────────────────────────────────────

interface MockResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

function createMockRes(): { res: http.ServerResponse; captured: MockResponse } {
  const captured: MockResponse = { statusCode: 0, body: {} };
  const res = {
    writeHead: (code: number) => { captured.statusCode = code; },
    setHeader: () => {},
    end: (data: string) => { captured.body = JSON.parse(data); },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

function createMockReq(body: Record<string, unknown>): http.IncomingMessage {
  return {
    method: 'POST',
    _rawBody: Buffer.from(JSON.stringify(body)),
  } as unknown as http.IncomingMessage;
}

function createMockDeps(overrides?: Partial<RouterDeps>): RouterDeps {
  return {
    config: {
      agent: { name: 'TestAgent' },
      'agent-comms': {
        enabled: true,
        peers: [{ name: 'agent-a', host: 'node-a.lan', port: 3847, ip: '10.0.0.1' }],
      },
      network: {
        communities: [{ name: 'home', primary: 'https://relay.example.com' }],
      },
    },
    sendViaLAN: async () => ({ ok: true }),
    getNetworkClient: () => null,
    getAgentCommsSecret: async () => 'test-secret',
    logCommsEntry: () => {},
    sendMessage: () => ({ messageId: 1, delivered: true }),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('POST /api/a2a/send — PAYLOAD_TOO_LARGE -> HTTP 413', () => {
  it('DM with oversized payload.text returns 413 with limit and actual size in body', async () => {
    setA2ARouter(new UnifiedA2ARouter(createMockDeps()));
    const { res, captured } = createMockRes();

    const handled = await handleA2ARoute(
      createMockReq({
        to: 'agent-a',
        payload: { type: 'text', text: 'x'.repeat(MAX_A2A_TEXT_LENGTH + 1) },
      }),
      res,
      '/api/a2a/send',
      new URLSearchParams(),
    );

    assert.ok(handled, 'handler should return true for /send');
    assert.equal(captured.statusCode, 413);
    assert.equal(captured.body.ok, false);
    assert.equal(captured.body.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(captured.body.maxLength, MAX_A2A_TEXT_LENGTH);
    assert.equal(captured.body.actualLength, MAX_A2A_TEXT_LENGTH + 1);
  });

  it('Group send with oversized payload.text also returns 413', async () => {
    setA2ARouter(new UnifiedA2ARouter(createMockDeps()));
    const { res, captured } = createMockRes();

    const handled = await handleA2ARoute(
      createMockReq({
        group: '00d0e9ff-8b2c-4009-a0a4-cc96af4b7827',
        payload: { type: 'text', text: 'x'.repeat(MAX_A2A_TEXT_LENGTH + 1) },
      }),
      res,
      '/api/a2a/send',
      new URLSearchParams(),
    );

    assert.ok(handled);
    assert.equal(captured.statusCode, 413);
    assert.equal(captured.body.code, 'PAYLOAD_TOO_LARGE');
  });

  it('DM with payload.text within limit still returns 200 (existing behavior unaffected)', async () => {
    setA2ARouter(new UnifiedA2ARouter(createMockDeps({
      sendViaLAN: async () => ({ ok: true }),
    })));
    const { res, captured } = createMockRes();

    const handled = await handleA2ARoute(
      createMockReq({
        to: 'agent-a',
        payload: { type: 'text', text: 'hello' },
      }),
      res,
      '/api/a2a/send',
      new URLSearchParams(),
    );

    assert.ok(handled);
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.ok, true);
  });
});
