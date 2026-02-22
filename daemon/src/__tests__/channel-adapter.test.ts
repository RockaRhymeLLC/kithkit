/**
 * t-145, t-146, t-147, t-148: Channel adapter interface and routing
 *
 * Tests the ChannelAdapter interface, multi-channel routing,
 * verbosity dial, and inbound message collection.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../core/db.js';
import { handleSendRoute } from '../api/send.js';
import {
  registerAdapter,
  unregisterAdapter,
  listAdapters,
  getVerbosity,
  setVerbosity,
  routeMessage,
  collectInbound,
  _resetForTesting,
} from '../comms/channel-router.js';
import type { ChannelAdapter, OutboundMessage, InboundMessage, Verbosity, ChannelCapabilities } from '../comms/adapter.js';

const TEST_PORT = 19890;

// ── Mock Adapter ─────────────────────────────────────────────

function createMockAdapter(name: string): ChannelAdapter & {
  sentMessages: OutboundMessage[];
  inboundQueue: InboundMessage[];
} {
  const sentMessages: OutboundMessage[] = [];
  const inboundQueue: InboundMessage[] = [];

  return {
    name,
    sentMessages,
    inboundQueue,

    async send(message: OutboundMessage): Promise<boolean> {
      sentMessages.push(message);
      return true;
    },

    async receive(): Promise<InboundMessage[]> {
      const messages = [...inboundQueue];
      inboundQueue.length = 0;
      return messages;
    },

    formatMessage(text: string, verbosity: Verbosity): string {
      switch (verbosity) {
        case 'headlines':
          // Truncate to first line/sentence
          return text.split('\n')[0].slice(0, 80);
        case 'verbose':
          return `[VERBOSE] ${text}`;
        case 'normal':
        default:
          return text;
      }
    },

    capabilities(): ChannelCapabilities {
      return {
        markdown: name === 'telegram',
        images: name === 'telegram',
        buttons: name === 'telegram',
        html: name === 'email',
        maxLength: name === 'telegram' ? 4096 : null,
      };
    },
  };
}

// ── HTTP test helpers ────────────────────────────────────────

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

function setupHttp(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-channel-'));
  _resetDbForTesting();
  _resetForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
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

// ── Tests ────────────────────────────────────────────────────

describe('ChannelAdapter interface implemented correctly (t-145)', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('mock adapter implements all required methods', () => {
    const adapter = createMockAdapter('test');

    assert.equal(typeof adapter.name, 'string');
    assert.equal(typeof adapter.send, 'function');
    assert.equal(typeof adapter.receive, 'function');
    assert.equal(typeof adapter.formatMessage, 'function');
    assert.equal(typeof adapter.capabilities, 'function');
  });

  it('adapter registered with channel router', () => {
    const adapter = createMockAdapter('telegram');
    registerAdapter(adapter);

    assert.deepEqual(listAdapters(), ['telegram']);
  });

  it('send() delivers through adapter', async () => {
    const adapter = createMockAdapter('telegram');
    registerAdapter(adapter);

    const results = await routeMessage({ text: 'Hello world' });
    assert.equal(results.telegram, true);
    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(adapter.sentMessages[0].text, 'Hello world');
  });

  it('capabilities() reports channel features', () => {
    const telegram = createMockAdapter('telegram');
    const caps = telegram.capabilities();

    assert.equal(caps.markdown, true);
    assert.equal(caps.images, true);
    assert.equal(caps.buttons, true);
    assert.equal(caps.maxLength, 4096);
  });
});

describe('Multi-channel routing works (t-146)', () => {
  beforeEach(setupHttp);
  afterEach(teardownHttp);

  it('sends through both adapters when both specified', async () => {
    const telegram = createMockAdapter('telegram');
    const email = createMockAdapter('email');
    registerAdapter(telegram);
    registerAdapter(email);

    const res = await request('POST', '/api/send', {
      message: 'Hello',
      channels: ['telegram', 'email'],
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.results.telegram, true);
    assert.equal(body.results.email, true);

    assert.equal(telegram.sentMessages.length, 1);
    assert.equal(email.sentMessages.length, 1);
  });

  it('sends only to specified channel', async () => {
    const telegram = createMockAdapter('telegram');
    const email = createMockAdapter('email');
    registerAdapter(telegram);
    registerAdapter(email);

    const res = await request('POST', '/api/send', {
      message: 'Telegram only',
      channels: ['telegram'],
    });

    assert.equal(res.status, 200);
    assert.equal(telegram.sentMessages.length, 1);
    assert.equal(email.sentMessages.length, 0);
  });

  it('sends to all when no channels specified', async () => {
    const telegram = createMockAdapter('telegram');
    const email = createMockAdapter('email');
    registerAdapter(telegram);
    registerAdapter(email);

    const res = await request('POST', '/api/send', {
      message: 'Broadcast',
    });

    assert.equal(res.status, 200);
    assert.equal(telegram.sentMessages.length, 1);
    assert.equal(email.sentMessages.length, 1);
  });
});

describe('Verbosity dial adjusts message format (t-147)', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('headlines truncates to first line', async () => {
    const telegram = createMockAdapter('telegram');
    registerAdapter(telegram);
    setVerbosity('telegram', 'headlines');

    await routeMessage({ text: 'First line\nSecond line\nThird line with lots of detail' });

    assert.equal(telegram.sentMessages.length, 1);
    assert.equal(telegram.sentMessages[0].text, 'First line');
  });

  it('verbose adds detail markers', async () => {
    const telegram = createMockAdapter('telegram');
    registerAdapter(telegram);
    setVerbosity('telegram', 'verbose');

    await routeMessage({ text: 'Test message' });

    assert.equal(telegram.sentMessages[0].text, '[VERBOSE] Test message');
  });

  it('normal passes through unchanged', async () => {
    const telegram = createMockAdapter('telegram');
    registerAdapter(telegram);
    setVerbosity('telegram', 'normal');

    await routeMessage({ text: 'Test message' });

    assert.equal(telegram.sentMessages[0].text, 'Test message');
  });

  it('different channels can have different verbosity', async () => {
    const telegram = createMockAdapter('telegram');
    const email = createMockAdapter('email');
    registerAdapter(telegram);
    registerAdapter(email);

    setVerbosity('telegram', 'headlines');
    setVerbosity('email', 'verbose');

    await routeMessage({ text: 'Multi-line\ndetail here' });

    assert.equal(telegram.sentMessages[0].text, 'Multi-line');
    assert.equal(email.sentMessages[0].text, '[VERBOSE] Multi-line\ndetail here');
  });

  it('default verbosity is normal', () => {
    const telegram = createMockAdapter('telegram');
    registerAdapter(telegram);

    assert.equal(getVerbosity('telegram'), 'normal');
  });
});

describe('Inbound messages from channels (t-148)', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('collects inbound messages from all channels', async () => {
    const telegram = createMockAdapter('telegram');
    const email = createMockAdapter('email');
    registerAdapter(telegram);
    registerAdapter(email);

    telegram.inboundQueue.push({
      from: 'Dave',
      text: 'Hey from Telegram',
      channel: 'telegram',
      receivedAt: '2026-02-22T10:00:00Z',
    });

    email.inboundQueue.push({
      from: 'dave@example.com',
      text: 'Email message',
      channel: 'email',
      receivedAt: '2026-02-22T10:01:00Z',
    });

    const messages = await collectInbound();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].channel, 'telegram');
    assert.equal(messages[1].channel, 'email');
  });

  it('messages sorted by receivedAt', async () => {
    const telegram = createMockAdapter('telegram');
    registerAdapter(telegram);

    telegram.inboundQueue.push(
      { from: 'Dave', text: 'Second', channel: 'telegram', receivedAt: '2026-02-22T10:01:00Z' },
      { from: 'Dave', text: 'First', channel: 'telegram', receivedAt: '2026-02-22T10:00:00Z' },
    );

    const messages = await collectInbound();
    assert.equal(messages[0].text, 'First');
    assert.equal(messages[1].text, 'Second');
  });

  it('receive drains the queue', async () => {
    const telegram = createMockAdapter('telegram');
    registerAdapter(telegram);

    telegram.inboundQueue.push({
      from: 'Dave',
      text: 'Hello',
      channel: 'telegram',
      receivedAt: '2026-02-22T10:00:00Z',
    });

    const first = await collectInbound();
    assert.equal(first.length, 1);

    const second = await collectInbound();
    assert.equal(second.length, 0);
  });
});

describe('Channel router management', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('unregister removes adapter', () => {
    const adapter = createMockAdapter('telegram');
    registerAdapter(adapter);
    assert.deepEqual(listAdapters(), ['telegram']);

    unregisterAdapter('telegram');
    assert.deepEqual(listAdapters(), []);
  });

  it('skips unknown channels in routing', async () => {
    const telegram = createMockAdapter('telegram');
    registerAdapter(telegram);

    const results = await routeMessage(
      { text: 'Hello' },
      ['telegram', 'nonexistent'],
    );

    assert.equal(results.telegram, true);
    assert.equal(results.nonexistent, undefined);
  });
});

describe('POST /api/send validation', () => {
  beforeEach(setupHttp);
  afterEach(teardownHttp);

  it('requires message field', async () => {
    const res = await request('POST', '/api/send', {});
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('message'));
  });
});
