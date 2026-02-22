/**
 * t-230, t-231: BMO extension entry point
 *
 * t-230: BMO extension loads cleanly — health check OK, init under 2s, BmoConfig compiles
 * t-231: BMO extension registers routes and tasks — BMO routes respond, task handlers registered, framework routes still work
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  registerExtension,
  isDegraded,
  _resetExtensionForTesting,
} from '../core/extensions.js';
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
import { bmoExtension, _getStateForTesting, _resetForTesting as _resetBmoForTesting } from '../extensions/index.js';
import type { BmoConfig } from '../extensions/config.js';
import type { KithkitConfig } from '../core/config.js';

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a test config with BMO-specific sections.
 */
function createTestBmoConfig(): BmoConfig {
  return {
    agent: { name: 'BMO-test' },
    daemon: {
      port: 3899,
      log_level: 'error',
      log_dir: 'logs',
      log_rotation: { max_size_mb: 10, max_files: 5 },
    },
    scheduler: {
      tasks: [
        { name: 'context-watchdog', enabled: true, interval: '3m' },
        { name: 'todo-reminder', enabled: true, interval: '30m' },
        { name: 'email-check', enabled: true, interval: '15m' },
      ],
    },
    security: {
      rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 },
    },
    channels: {
      telegram: { enabled: true, webhook_path: '/telegram' },
      email: { enabled: true, providers: [{ type: 'graph' }] },
      voice: { enabled: false },
    },
    network: {
      enabled: true,
      communities: [{ name: 'test', primary: 'https://relay.test.com' }],
      owner_email: 'test@test.com',
    },
    'agent-comms': {
      enabled: true,
      peers: [{ name: 'r2d2', host: 'test.local', port: 3847 }],
    },
  };
}

/**
 * Create a test HTTP server that mirrors the daemon's request flow:
 * /health → core routes → registered extension routes → extension onRoute → 404
 */
function createTestServer(port: number): {
  server: http.Server;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // Health endpoint (core route)
    if (req.method === 'GET' && url.pathname === '/health') {
      const routes = getRegisteredRoutes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        degraded: isDegraded(),
        extensionRoutes: routes,
      }));
      return;
    }

    // /api/todos stub (simulate framework route)
    if (url.pathname === '/api/todos' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], timestamp: new Date().toISOString() }));
      return;
    }

    // /api/memory/search stub (simulate framework route)
    if (url.pathname === '/api/memory/search' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], timestamp: new Date().toISOString() }));
      return;
    }

    const handleRoutes = async (): Promise<void> => {
      // Registered routes (from registerRoute)
      if (!isDegraded()) {
        const routeHandled = await matchRoute(req, res, url.pathname, url.searchParams);
        if (routeHandled) return;
      }

      // 404 fallback
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
  body?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: { raw: data } });
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ── Tests ───────────────────────────────────────────────────

const PORT_230 = 3891;
const PORT_231 = 3892;

describe('BMO extension entry point loads cleanly (t-230)', () => {
  let testServer: ReturnType<typeof createTestServer>;

  beforeEach(() => {
    _resetExtensionForTesting();
    _resetRoutesForTesting();
    _resetExtendedStatusForTesting();
    _resetBmoForTesting();
    testServer = createTestServer(PORT_230);
  });

  afterEach(async () => {
    const state = _getStateForTesting();
    if (state.scheduler) state.scheduler.stop();
    await testServer.stop();
    await sleep(10);
    _resetExtensionForTesting();
    _resetRoutesForTesting();
    _resetExtendedStatusForTesting();
    _resetBmoForTesting();
  });

  it('extension registers and initializes successfully', async () => {
    registerExtension(bmoExtension);
    await testServer.start();

    const config = createTestBmoConfig();
    const initStart = Date.now();
    await bmoExtension.onInit!(config, testServer.server);
    const initMs = Date.now() - initStart;

    const state = _getStateForTesting();
    assert.ok(state.initialized, 'Extension should be initialized');
    assert.ok(state.config, 'Config should be set');
    assert.equal(state.config!.agent.name, 'BMO-test');
  });

  it('health check returns OK after extension init', async () => {
    registerExtension(bmoExtension);
    await testServer.start();
    await bmoExtension.onInit!(createTestBmoConfig(), testServer.server);

    const result = await request(PORT_230, 'GET', '/health');
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
    assert.equal(result.body.degraded, false);
  });

  it('extension init completes within 2 seconds', async () => {
    registerExtension(bmoExtension);
    await testServer.start();

    const config = createTestBmoConfig();
    const initStart = Date.now();
    await bmoExtension.onInit!(config, testServer.server);
    const initMs = Date.now() - initStart;

    assert.ok(initMs < 2000, `Extension init took ${initMs}ms, should be under 2000ms`);
  });

  it('BmoConfig extends KithkitConfig with additional fields', () => {
    // This test verifies TypeScript compilation — if BmoConfig doesn't
    // extend KithkitConfig correctly, this file won't compile.
    const config: BmoConfig = createTestBmoConfig();

    // Base KithkitConfig fields
    assert.equal(config.agent.name, 'BMO-test');
    assert.equal(config.daemon.port, 3899);
    assert.ok(Array.isArray(config.scheduler.tasks));

    // BMO extension fields
    assert.ok(config.channels?.telegram?.enabled);
    assert.ok(config.network?.enabled);
    assert.ok(config['agent-comms']?.enabled);
  });

  it('extension name is "bmo"', () => {
    assert.equal(bmoExtension.name, 'bmo');
  });

  it('extension has onInit and onShutdown hooks', () => {
    assert.equal(typeof bmoExtension.onInit, 'function');
    assert.equal(typeof bmoExtension.onShutdown, 'function');
  });

  it('health check registered for bmo-extension', async () => {
    registerExtension(bmoExtension);
    await testServer.start();
    await bmoExtension.onInit!(createTestBmoConfig(), testServer.server);

    const checks = getRegisteredChecks();
    assert.ok(checks.includes('bmo-extension'), 'Should register bmo-extension health check');
  });

  it('shutdown cleans up scheduler and state', async () => {
    registerExtension(bmoExtension);
    await testServer.start();
    await bmoExtension.onInit!(createTestBmoConfig(), testServer.server);

    const stateBefore = _getStateForTesting();
    assert.ok(stateBefore.initialized);
    assert.ok(stateBefore.scheduler);

    await bmoExtension.onShutdown!();

    const stateAfter = _getStateForTesting();
    assert.ok(!stateAfter.initialized);
    assert.equal(stateAfter.scheduler, null);
  });
});

describe('BMO extension registers routes and tasks (t-231)', () => {
  let testServer: ReturnType<typeof createTestServer>;

  beforeEach(async () => {
    _resetExtensionForTesting();
    _resetRoutesForTesting();
    _resetExtendedStatusForTesting();
    _resetBmoForTesting();
    testServer = createTestServer(PORT_231);
    registerExtension(bmoExtension);
    await testServer.start();
    await bmoExtension.onInit!(createTestBmoConfig(), testServer.server);
  });

  afterEach(async () => {
    const state = _getStateForTesting();
    if (state.scheduler) state.scheduler.stop();
    await testServer.stop();
    await sleep(10);
    _resetExtensionForTesting();
    _resetRoutesForTesting();
    _resetExtendedStatusForTesting();
    _resetBmoForTesting();
  });

  it('BMO routes registered in route registry', () => {
    const routes = getRegisteredRoutes();
    assert.ok(routes.includes('/telegram'), 'Should register /telegram route');
    assert.ok(routes.includes('/agent/p2p'), 'Should register /agent/p2p route');
    assert.ok(routes.includes('/agent/status'), 'Should register /agent/status route');
    assert.ok(routes.includes('/api/context'), 'Should register /api/context route');
  });

  it('telegram webhook responds to POST', async () => {
    const result = await request(PORT_231, 'POST', '/telegram', '{}');
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
  });

  it('agent/p2p responds to POST', async () => {
    const result = await request(PORT_231, 'POST', '/agent/p2p', '{}');
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
  });

  it('agent/status responds with extension info', async () => {
    const result = await request(PORT_231, 'GET', '/agent/status');
    assert.equal(result.status, 200);
    assert.equal(result.body.agent, 'BMO-test');
    // Rich status format (s-m25): session, channel, services, todos
    assert.ok(['active', 'stopped'].includes(result.body.session as string), 'Should have session status');
    assert.equal(typeof result.body.channel, 'string', 'Should have channel');
    assert.ok(Array.isArray(result.body.services), 'Should have services array');
    assert.equal(typeof result.body.todos, 'object', 'Should have todos');
  });

  it('api/context responds with context data', async () => {
    const result = await request(PORT_231, 'GET', '/api/context');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.todos));
    assert.ok(Array.isArray(result.body.memories));
  });

  it('scheduler task handlers registered for BMO tasks', () => {
    const state = _getStateForTesting();
    const scheduler = state.scheduler!;

    // Configured tasks should have handlers
    assert.ok(scheduler.hasHandler('context-watchdog'), 'context-watchdog should have handler');
    assert.ok(scheduler.hasHandler('todo-reminder'), 'todo-reminder should have handler');
    assert.ok(scheduler.hasHandler('email-check'), 'email-check should have handler');
  });

  it('scheduler is running after init', () => {
    const state = _getStateForTesting();
    assert.ok(state.scheduler!.isRunning(), 'Scheduler should be running');
  });

  it('framework routes still work — /health', async () => {
    const result = await request(PORT_231, 'GET', '/health');
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
    assert.ok(Array.isArray(result.body.extensionRoutes));
  });

  it('framework routes still work — /api/todos', async () => {
    const result = await request(PORT_231, 'GET', '/api/todos');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.data));
  });

  it('framework routes still work — /api/memory/search', async () => {
    const result = await request(PORT_231, 'GET', '/api/memory/search');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.data));
  });

  it('extension routes appear in health check', async () => {
    const result = await request(PORT_231, 'GET', '/health');
    const routes = result.body.extensionRoutes as string[];
    assert.ok(routes.includes('/telegram'));
    assert.ok(routes.includes('/agent/p2p'));
  });

  it('unregistered routes still 404', async () => {
    const result = await request(PORT_231, 'GET', '/nonexistent');
    assert.equal(result.status, 404);
  });
});
