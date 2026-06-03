/**
 * t-200, t-201, t-201b: Extension hooks system
 * t-202: onConfigChange hook propagates to subsystems
 *
 * Tests the extension lifecycle: registration, init/route/shutdown hooks,
 * degraded mode on init failure, no-op behavior without extensions,
 * and config-change cache invalidation across scheduler, agent-comms, and rate limiter.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  registerExtension,
  isDegraded,
  setDegraded,
  _getExtensionForTesting,
  _resetExtensionForTesting,
  type Extension,
} from '../core/extensions.js';
import { openDatabase, closeDatabase } from '../core/db.js';
import { Scheduler } from '../automation/scheduler.js';
import { agentExtension, _setSchedulerForTesting, _resetForTesting as _resetExtensionState } from '../extensions/index.js';
import { getAgentStatus, stopAgentComms } from '../extensions/comms/agent-comms.js';
import type { KithkitConfig } from '../core/config.js';

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a minimal HTTP server that mimics the daemon's request flow:
 * core routes → extension onRoute → 404 fallback.
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', degraded: isDegraded() }));
      return;
    }

    const handleRoutes = async (): Promise<void> => {
      // Extension routes (before 404, skipped if degraded)
      const ext = _getExtensionForTesting();
      if (ext?.onRoute && !isDegraded()) {
        const handled = await ext.onRoute(req, res, url.pathname, url.searchParams);
        if (handled) return;
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      timeout: 3000,
      headers: { Connection: 'close' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: data ? JSON.parse(data) : {},
      }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

const TEST_PORT = 19880;

// ── t-200: Extension hooks are no-ops when unused ────────────

describe('Extension hooks no-op without extensions (t-200)', () => {
  let testServer: ReturnType<typeof createTestServer>;

  beforeEach(async () => {
    _resetExtensionForTesting();
    testServer = createTestServer(TEST_PORT);
    await testServer.start();
  });

  afterEach(async () => {
    await testServer.stop();
    _resetExtensionForTesting();
  });

  it('daemon starts with no extension registered', () => {
    assert.equal(_getExtensionForTesting(), null);
    assert.equal(isDegraded(), false);
  });

  it('health endpoint returns OK with no extension', async () => {
    const res = await request(TEST_PORT, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.degraded, false);
  });

  it('non-existent route returns 404 with no extension', async () => {
    const res = await request(TEST_PORT, 'GET', '/some/random/path');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });

  it('shutdown completes without errors when no extension', async () => {
    // Just verify server stops cleanly
    await testServer.stop();
    // Re-create for afterEach
    testServer = createTestServer(TEST_PORT);
    await testServer.start();
  });
});

// ── t-201: Extension hooks fire in correct order ─────────────

describe('Extension hooks fire in correct order (t-201)', () => {
  let testServer: ReturnType<typeof createTestServer>;
  const events: string[] = [];

  beforeEach(async () => {
    _resetExtensionForTesting();
    events.length = 0;
    testServer = createTestServer(TEST_PORT);
  });

  afterEach(async () => {
    await testServer.stop();
    _resetExtensionForTesting();
  });

  it('lifecycle order: init → route → shutdown', async () => {
    const testExtension: Extension = {
      name: 'test-lifecycle',
      async onInit() {
        events.push('init');
      },
      async onRoute(req, res, pathname) {
        if (pathname === '/ext/hello') {
          events.push('route');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ from: 'extension' }));
          return true;
        }
        return false;
      },
      async onShutdown() {
        events.push('shutdown');
      },
    };

    registerExtension(testExtension);
    assert.equal(_getExtensionForTesting()?.name, 'test-lifecycle');

    // Start server and simulate init
    await testServer.start();
    await testExtension.onInit!({} as never, testServer.server);
    assert.deepEqual(events, ['init']);

    // Send request to extension route
    const res = await request(TEST_PORT, 'GET', '/ext/hello');
    assert.equal(res.status, 200);
    assert.equal(res.body.from, 'extension');
    assert.deepEqual(events, ['init', 'route']);

    // Shutdown
    await testExtension.onShutdown!();
    assert.deepEqual(events, ['init', 'route', 'shutdown']);
  });

  it('extension route passes through for unhandled paths', async () => {
    const testExtension: Extension = {
      name: 'test-passthrough',
      async onRoute(_req, _res, pathname) {
        if (pathname === '/ext/handled') return true;
        return false;
      },
    };

    registerExtension(testExtension);
    await testServer.start();

    // Unhandled path falls through to 404
    const res = await request(TEST_PORT, 'GET', '/ext/not-handled');
    assert.equal(res.status, 404);
  });

  it('only one extension can be registered', () => {
    registerExtension({ name: 'first' });
    assert.throws(
      () => registerExtension({ name: 'second' }),
      (err: Error) => {
        assert.ok(err.message.includes('already registered'));
        assert.ok(err.message.includes('first'));
        return true;
      },
    );
  });
});

// ── t-201b: Bad extension init → degraded mode ──────────────

describe('Extension with bad init runs in degraded mode (t-201b)', () => {
  let testServer: ReturnType<typeof createTestServer>;

  beforeEach(async () => {
    _resetExtensionForTesting();
    testServer = createTestServer(TEST_PORT);
  });

  afterEach(async () => {
    await testServer.stop();
    _resetExtensionForTesting();
  });

  it('daemon continues in degraded mode when init throws', async () => {
    const testExtension: Extension = {
      name: 'bad-init-ext',
      async onInit() {
        throw new Error('Init failed: connection refused');
      },
      async onRoute(_req, res, pathname) {
        if (pathname === '/ext/should-not-work') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ from: 'extension' }));
          return true;
        }
        return false;
      },
    };

    registerExtension(testExtension);
    await testServer.start();

    // Simulate what main.ts does: call onInit, catch error, set degraded
    assert.equal(isDegraded(), false);

    try {
      await testExtension.onInit!({} as never, testServer.server);
    } catch {
      setDegraded(true);
    }

    assert.equal(isDegraded(), true);
    assert.equal(_getExtensionForTesting()?.name, 'bad-init-ext');

    // Core services still work
    const healthRes = await request(TEST_PORT, 'GET', '/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.body.degraded, true);

    // Extension routes are SKIPPED when degraded
    const extRes = await request(TEST_PORT, 'GET', '/ext/should-not-work');
    assert.equal(extRes.status, 404, 'Extension routes should be skipped in degraded mode');
  });

  it('isDegraded() returns false initially and after reset', () => {
    assert.equal(isDegraded(), false);

    registerExtension({ name: 'some-ext' });
    setDegraded(true);
    assert.equal(isDegraded(), true);

    _resetExtensionForTesting();
    assert.equal(isDegraded(), false);
  });

  it('health endpoint reflects degraded state', async () => {
    await testServer.start();

    // Without degradation
    let res = await request(TEST_PORT, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.degraded, false);

    // Set degraded
    setDegraded(true);
    res = await request(TEST_PORT, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.degraded, true);
  });

  it('extension routes are skipped when degraded', async () => {
    const testExtension: Extension = {
      name: 'route-ext',
      async onRoute(_req, res, pathname) {
        if (pathname === '/ext/test') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return true;
        }
        return false;
      },
    };

    registerExtension(testExtension);
    await testServer.start();

    // Works normally
    let res = await request(TEST_PORT, 'GET', '/ext/test');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    // Set degraded — route should be skipped
    setDegraded(true);
    res = await request(TEST_PORT, 'GET', '/ext/test');
    assert.equal(res.status, 404, 'Extension route should be skipped when degraded');
  });
});

// ── t-202: onConfigChange propagates to subsystems ───────────

function makeFullConfig(overrides: Partial<KithkitConfig> = {}): KithkitConfig {
  return {
    agent: { name: 'TestAgent', ...overrides.agent },
    daemon: {
      port: 3847,
      log_level: 'info',
      log_dir: 'logs',
      log_rotation: { max_size_mb: 10, max_files: 5 },
      ...overrides.daemon,
    },
    scheduler: { tasks: [], ...overrides.scheduler },
    security: {
      rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 },
      ...overrides.security,
    },
  };
}

describe('onConfigChange hook propagates to subsystems (t-202)', { concurrency: 1 }, () => {
  let tmpDir: string;
  let testScheduler: Scheduler | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-ext-test-'));
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    testScheduler = null;
    _resetExtensionState();
  });

  afterEach(() => {
    testScheduler?.stop();
    testScheduler = null;
    stopAgentComms();
    _resetExtensionState();
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('onConfigChange calls scheduler.reload() so new tasks take effect', () => {
    const initialTasks = [{ name: 'task-alpha', enabled: true, interval: '5m', config: {} }];
    testScheduler = new Scheduler({ tasks: initialTasks, autoRegisterCoreTasks: false });
    _setSchedulerForTesting(testScheduler);

    assert.ok(testScheduler.getTask('task-alpha'), 'Initial task should exist');

    const newTasks = [{ name: 'task-beta', enabled: true, interval: '10m', config: {} }];
    const newConfig = makeFullConfig({ scheduler: { tasks: newTasks } });

    agentExtension.onConfigChange!(newConfig);

    assert.ok(testScheduler.getTask('task-beta'), 'New task should be present after reload');
    assert.equal(testScheduler.getTask('task-alpha'), undefined, 'Removed task should be gone after reload');
  });

  it('onConfigChange with no scheduler does not throw', () => {
    // _scheduler is null — must not throw
    const config = makeFullConfig();
    assert.doesNotThrow(() => agentExtension.onConfigChange!(config));
  });

  it('onConfigChange refreshes agent-comms peer config', () => {
    // After onConfigChange, getAgentStatus() should reflect the new agent name
    // (agent-comms caches _config; refreshAgentCommsConfig updates it)
    const config = makeFullConfig({ agent: { name: 'RefreshedName' } });
    agentExtension.onConfigChange!(config);

    const status = getAgentStatus();
    assert.equal(status.agent, 'RefreshedName', 'Agent-comms should use refreshed config after onConfigChange');
  });

  it('onConfigChange is a no-op when extension object has no onConfigChange', () => {
    // Verify the hook is optional — registering an extension without onConfigChange
    // and calling it should not throw
    const ext: Extension = { name: 'no-config-change' };
    assert.equal(ext.onConfigChange, undefined);
    // Calling undefined onConfigChange should not throw (caller guards with ?)
    assert.doesNotThrow(() => ext.onConfigChange?.(makeFullConfig()));
  });
});
