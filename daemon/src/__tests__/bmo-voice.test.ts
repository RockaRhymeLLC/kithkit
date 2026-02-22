/**
 * t-236: BMO voice pipeline serves clients
 *
 * Verify voice server, STT, TTS, and client registry work.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  registerRoute,
  matchRoute,
  getRegisteredRoutes,
  _resetRoutesForTesting,
} from '../core/route-registry.js';
import {
  registerCheck,
  getRegisteredChecks,
  _resetForTesting as _resetExtendedStatusForTesting,
} from '../core/extended-status.js';
import {
  registerClient,
  unregisterClient,
  getRegistryStatus,
  isVoiceAvailable,
  getConnectedClients,
  getPrimaryClient,
  startPruner,
  stopPruner,
  _testHelpers,
} from '../extensions/voice/voice-client-registry.js';
import { isHallucination, _resetForTesting as _resetSTTForTesting } from '../extensions/voice/stt.js';
import { isWorkerReady, _resetForTesting as _resetTTSForTesting } from '../extensions/voice/tts.js';
import { _isEnabled, _resetForTesting as _resetVoiceForTesting } from '../extensions/voice/index.js';
import type { VoiceConfig } from '../extensions/config.js';

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a test server that dispatches to registered routes.
 */
function createTestServer(port: number): {
  server: http.Server;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    const handleRoutes = async (): Promise<void> => {
      const handled = await matchRoute(req, res, url.pathname, url.searchParams);
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    };

    handleRoutes().catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  return {
    server,
    start: () => new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve)),
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: string | Buffer,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; rawBody?: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw.toString()), rawBody: raw });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: { raw: raw.toString() }, rawBody: raw });
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ── Tests ───────────────────────────────────────────────────

const PORT = 3896;

describe('Voice client registry (t-236)', () => {
  beforeEach(() => {
    _testHelpers.clearAll();
  });

  afterEach(() => {
    stopPruner();
    _testHelpers.clearAll();
  });

  it('registers a client and reports available', () => {
    assert.equal(isVoiceAvailable(), false);
    registerClient('test-1', 'http://192.168.1.100:7331', '192.168.1.100');
    assert.equal(isVoiceAvailable(), true);
    assert.equal(getConnectedClients().length, 1);
    assert.equal(getPrimaryClient()?.clientId, 'test-1');
  });

  it('heartbeat updates lastSeen', async () => {
    registerClient('test-1', 'http://192.168.1.100:7331', '192.168.1.100');
    const firstSeen = getPrimaryClient()!.lastSeen;
    await sleep(10);
    registerClient('test-1', 'http://192.168.1.100:7331', '192.168.1.100');
    const secondSeen = getPrimaryClient()!.lastSeen;
    assert.ok(secondSeen > firstSeen, 'lastSeen should be updated');
  });

  it('unregister removes client', () => {
    registerClient('test-1', 'http://192.168.1.100:7331', '192.168.1.100');
    assert.equal(isVoiceAvailable(), true);
    const removed = unregisterClient('test-1');
    assert.equal(removed, true);
    assert.equal(isVoiceAvailable(), false);
  });

  it('status returns correct shape', () => {
    registerClient('test-1', 'http://192.168.1.100:7331', '192.168.1.100');
    const status = getRegistryStatus();
    assert.equal(status.connected, true);
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0].clientId, 'test-1');
  });
});

describe('STT hallucination filter (t-236)', () => {
  it('empty string is hallucination', () => {
    assert.equal(isHallucination(''), true);
    assert.equal(isHallucination('  '), true);
  });

  it('known patterns are hallucinations', () => {
    assert.equal(isHallucination('you'), true);
    assert.equal(isHallucination('Thank you.'), true);
    assert.equal(isHallucination('bye bye'), true);
    assert.equal(isHallucination('subscribe'), true);
  });

  it('single chars are hallucinations', () => {
    assert.equal(isHallucination('a'), true);
    assert.equal(isHallucination('I'), true);
  });

  it('music notation is hallucination', () => {
    assert.equal(isHallucination('♪'), true);
    assert.equal(isHallucination('(music)'), true);
  });

  it('real speech is not hallucination', () => {
    assert.equal(isHallucination('Hello BMO'), false);
    assert.equal(isHallucination('What is the weather like today?'), false);
    assert.equal(isHallucination('turn off the lights'), false);
  });
});

describe('TTS worker state (t-236)', () => {
  beforeEach(() => {
    _resetTTSForTesting();
  });

  it('worker is not ready before init', () => {
    assert.equal(isWorkerReady(), false);
  });
});

describe('Voice routes registered via extension (t-236)', () => {
  let testServer: ReturnType<typeof createTestServer>;

  beforeEach(async () => {
    _resetRoutesForTesting();
    _resetExtendedStatusForTesting();
    _resetVoiceForTesting();
    _resetSTTForTesting();
    _resetTTSForTesting();
    _testHelpers.clearAll();
    testServer = createTestServer(PORT);
  });

  afterEach(async () => {
    stopPruner();
    _testHelpers.clearAll();
    await testServer.stop();
    await sleep(10);
    _resetRoutesForTesting();
    _resetExtendedStatusForTesting();
    _resetVoiceForTesting();
    _resetSTTForTesting();
    _resetTTSForTesting();
  });

  it('voice routes registered when voice is disabled', async () => {
    // Import and call initVoice with disabled config
    const { initVoice, stopVoice } = await import('../extensions/voice/index.js');
    await initVoice({ enabled: false });
    await testServer.start();

    const routes = getRegisteredRoutes();
    assert.ok(routes.includes('/voice/register'), 'Should register /voice/register');
    assert.ok(routes.includes('/voice/status'), 'Should register /voice/status');
    assert.ok(routes.includes('/voice/stt'), 'Should register /voice/stt');
    assert.ok(routes.includes('/voice/transcribe'), 'Should register /voice/transcribe');
    assert.ok(routes.includes('/voice/speak'), 'Should register /voice/speak');
    assert.ok(routes.includes('/voice/notify'), 'Should register /voice/notify');
    assert.ok(routes.includes('/voice/unregister'), 'Should register /voice/unregister');

    stopVoice();
  });

  it('voice endpoints return 503 when disabled', async () => {
    const { initVoice, stopVoice } = await import('../extensions/voice/index.js');
    await initVoice({ enabled: false });
    await testServer.start();

    const result = await request(PORT, 'POST', '/voice/register', JSON.stringify({ clientId: 'test-1' }));
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'Voice is not enabled');

    stopVoice();
  });

  it('voice/status returns registry info even when disabled', async () => {
    const { initVoice, stopVoice } = await import('../extensions/voice/index.js');
    await initVoice({ enabled: false });
    await testServer.start();

    // status endpoint works even when disabled (GET, no enablement check)
    const result = await request(PORT, 'GET', '/voice/status');
    assert.equal(result.status, 200);
    assert.equal(result.body.connected, false);
    assert.ok(Array.isArray(result.body.clients));

    stopVoice();
  });

  it('voice health check registered', async () => {
    const { initVoice, stopVoice } = await import('../extensions/voice/index.js');
    await initVoice({ enabled: false });

    const checks = getRegisteredChecks();
    assert.ok(checks.includes('voice'), 'Should register voice health check');

    stopVoice();
  });
});

describe('Browser sidecar config type (t-236)', () => {
  it('BrowserbaseConfig interface has required fields', async () => {
    // Compile-time check — if the type doesn't match, this won't compile
    const { asBmoConfig } = await import('../extensions/config.js');
    const config = asBmoConfig({
      agent: { name: 'test' },
      daemon: { port: 3847, log_level: 'error', log_dir: 'logs', log_rotation: { max_size_mb: 10, max_files: 5 } },
      scheduler: { tasks: [] },
      security: { rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 } },
    });

    // Set browserbase config
    config.integrations = {
      browserbase: {
        enabled: true,
        sidecar_port: 3849,
        default_timeout: 300,
        handoff_timeout: 300,
        block_ads: true,
      },
    };

    assert.ok(config.integrations?.browserbase?.enabled);
    assert.equal(config.integrations?.browserbase?.sidecar_port, 3849);
  });
});
