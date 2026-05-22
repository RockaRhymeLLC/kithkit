/**
 * Regression tests for kithkit#307:
 *   /api/send to-field truncation + long-payload clipping
 *
 * Root cause: TelegramAdapter.formatMessage() and telegramSend() both
 * hard-cap at 4000 chars (real Telegram limit is 4096). Messages between
 * 4001–4096 chars are silently truncated; messages > 4096 should be
 * chunked instead of destroyed.
 *
 * These tests fail on main (formatMessage clips at 4000, returns 4003).
 * They pass after the fix (formatMessage passes text through; chunked
 * delivery in telegramSend handles the protocol limit).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../core/db.js';
import { handleSendRoute } from '../api/send.js';
import { issueToken } from '../auth/agent-tokens.js';
import {
  registerAdapter,
  _resetForTesting,
} from '../comms/channel-router.js';
import type {
  ChannelAdapter,
  OutboundMessage,
  InboundMessage,
  Verbosity,
  ChannelCapabilities,
} from '../comms/adapter.js';
import { TelegramAdapter } from '../extensions/comms/adapters/telegram.js';

const TEST_PORT = 19893;

// ── Adapter fixture ──────────────────────────────────────────
//
// Uses the REAL TelegramAdapter.formatMessage (inherits the truncation bug
// on main) but overrides send/receive so no actual network I/O occurs.

function createCapturingTelegramAdapter(): ChannelAdapter & { captured: OutboundMessage[] } {
  const realAdapter = new TelegramAdapter();
  const captured: OutboundMessage[] = [];

  return {
    name: 'telegram',
    captured,

    async send(message: OutboundMessage): Promise<boolean> {
      captured.push({ ...message });
      return true;
    },

    async receive(): Promise<InboundMessage[]> {
      return [];
    },

    formatMessage(text: string, verbosity: Verbosity): string {
      return realAdapter.formatMessage(text, verbosity);
    },

    capabilities(): ChannelCapabilities {
      return realAdapter.capabilities();
    },
  };
}

// ── HTTP test helpers ─────────────────────────────────────────

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
        Connection: 'close',
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
let testCommsToken = '';

function setupHttp(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-307-'));
  _resetDbForTesting();
  _resetForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  testCommsToken = issueToken('comms');

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    handleSendRoute(inReq, res, url.pathname)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardownHttp(): Promise<void> {
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    _resetForTesting();
    server.close(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

// ── Unit tests: TelegramAdapter.formatMessage ─────────────────

describe('TelegramAdapter.formatMessage does not clip below Telegram limit (t-307a)', () => {
  it('normal verbosity: message at 4095 chars passes through unchanged', () => {
    const adapter = new TelegramAdapter();
    const text = 'x'.repeat(4095);
    const result = adapter.formatMessage(text, 'normal');
    assert.equal(
      result.length,
      4095,
      `Expected 4095 chars, got ${result.length} — formatMessage must not truncate below the 4096-char Telegram limit`,
    );
  });

  it('normal verbosity: message at 4096 chars passes through unchanged', () => {
    const adapter = new TelegramAdapter();
    const text = 'x'.repeat(4096);
    const result = adapter.formatMessage(text, 'normal');
    assert.equal(
      result.length,
      4096,
      `Expected 4096 chars, got ${result.length}`,
    );
  });

  it('normal verbosity: 5000-char message is not clipped by formatMessage', () => {
    const adapter = new TelegramAdapter();
    const text = 'x'.repeat(5000);
    const result = adapter.formatMessage(text, 'normal');
    // Bug on main: returns 4003 (substring(0,4000) + '...')
    // After fix:   returns 5000 (no truncation in formatMessage)
    assert.equal(
      result.length,
      5000,
      `Expected 5000 chars, got ${result.length} — long-payload clipping bug (#307): ` +
      `formatMessage must not destroy content; chunked delivery in telegramSend handles the protocol limit`,
    );
  });

  it('verbose verbosity: passes through unchanged regardless of length', () => {
    const adapter = new TelegramAdapter();
    const text = 'x'.repeat(5000);
    assert.equal(adapter.formatMessage(text, 'verbose').length, 5000);
  });
});

// ── Integration test: POST /api/send → adapter pipeline ───────

describe('POST /api/send 5000-char payload round-trips without truncation (#307)', () => {
  before(setupHttp);
  after(teardownHttp);

  it('5000-char message body reaches adapter with full length via /api/send', async () => {
    const adapter = createCapturingTelegramAdapter();
    registerAdapter(adapter);

    const longMessage = 'x'.repeat(5000);
    const res = await request(
      'POST',
      '/api/send',
      { message: longMessage, channels: ['telegram'] },
      { 'X-Agent-Token': testCommsToken },
    );

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${res.body}`);

    // The adapter must have received at least one message
    assert.ok(adapter.captured.length >= 1, 'Adapter received no messages');

    // All captured chunks combined must equal the original message length
    const totalReceived = adapter.captured.reduce((sum, m) => sum + m.text.length, 0);
    assert.equal(
      totalReceived,
      5000,
      `Expected total 5000 chars across all adapter.send() calls, got ${totalReceived} — ` +
      `long-payload clipping bug (#307): /api/send must not destroy message content`,
    );
  });

  it('4275-char message (BMO repro from 5/20) reaches adapter intact', async () => {
    const adapter = createCapturingTelegramAdapter();
    registerAdapter(adapter);

    const auditMessage = 'a'.repeat(4275);
    const res = await request(
      'POST',
      '/api/send',
      { message: auditMessage, channels: ['telegram'] },
      { 'X-Agent-Token': testCommsToken },
    );

    assert.equal(res.status, 200);

    const totalReceived = adapter.captured.reduce((sum, m) => sum + m.text.length, 0);
    assert.equal(
      totalReceived,
      4275,
      `Expected 4275 chars, got ${totalReceived} — this is the exact BMO→Bridget repro from 2026-05-20 (#307)`,
    );
  });
});
