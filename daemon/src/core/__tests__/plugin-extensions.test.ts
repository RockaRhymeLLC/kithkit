/**
 * Tests for hot-loadable plugin extensions (PluginManager).
 *
 * Covers: load (routes + tasks + onInit ctx), cache-busted reload, unload,
 * broken-file containment, namespace enforcement, conflict rollback,
 * onInit-failure rollback, and directory scan add/remove semantics.
 *
 * fs.watch is NOT exercised here (timing-flaky); the watcher delegates to the
 * same loadFile/unload methods tested directly.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { loadConfig, _resetConfigForTesting } from '../config.js';
import { matchRoute, registerRoute, _resetRoutesForTesting, getRegisteredRoutes } from '../route-registry.js';
import { PluginManager, _resetPluginManagerForTesting } from '../plugin-extensions.js';
import { Scheduler } from '../../automation/scheduler.js';

// ── Harness ──────────────────────────────────────────────────

let tmpDir: string;
let pluginsDir: string;
let scheduler: Scheduler;
let manager: PluginManager;

function makeManager(): PluginManager {
  return new PluginManager({
    dir: pluginsDir,
    config: loadConfig(tmpDir),
    getScheduler: () => scheduler,
  });
}

function writePlugin(filename: string, body: string): string {
  const file = path.join(pluginsDir, filename);
  fs.writeFileSync(file, body);
  return file;
}

/** Minimal fake req/res for matchRoute; captures status + body. */
function fakeReqRes(): { req: http.IncomingMessage; res: http.ServerResponse; out: { status?: number; body?: string } } {
  const out: { status?: number; body?: string } = {};
  const req = { method: 'GET', headers: {} } as unknown as http.IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(status: number) { out.status = status; return this; },
    end(body?: string) { out.body = body; },
  } as unknown as http.ServerResponse;
  return { req, res, out };
}

const VALID_PLUGIN = `
export default {
  name: 'demo',
  routes: {
    '/api/ext/demo/hello': async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ msg: 'v1' }));
      return true;
    },
  },
  tasks: [{
    name: 'demo-tick',
    schedule: { type: 'interval', ms: 60000 },
    run: async () => {},
  }],
};
`;

beforeEach(() => {
  _resetConfigForTesting();
  _resetRoutesForTesting();
  _resetPluginManagerForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-plugins-'));
  pluginsDir = path.join(tmpDir, 'extensions');
  fs.mkdirSync(pluginsDir);
  scheduler = new Scheduler({ tasks: [], tickIntervalMs: 3600_000 });
  manager = makeManager();
});

afterEach(async () => {
  await manager.stop();
  scheduler.stop();
  _resetRoutesForTesting();
  _resetPluginManagerForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Load ─────────────────────────────────────────────────────

describe('PluginManager: load', () => {
  it('loads a valid plugin: route served, task registered', async () => {
    const file = writePlugin('demo.js', VALID_PLUGIN);

    const record = await manager.loadFile(file);
    assert.equal(record.status, 'loaded');
    assert.equal(record.name, 'demo');
    assert.deepEqual(record.routes, ['/api/ext/demo/hello']);
    assert.deepEqual(record.tasks, ['demo-tick']);

    const { req, res, out } = fakeReqRes();
    const handled = await matchRoute(req, res, '/api/ext/demo/hello', new URLSearchParams());
    assert.equal(handled, true);
    assert.equal(out.status, 200);
    assert.equal(JSON.parse(out.body!).msg, 'v1');

    assert.equal(scheduler.hasHandler('demo-tick'), true);
  });

  it('passes a working context to onInit', async () => {
    const probe = path.join(tmpDir, 'init-probe.json');
    const file = writePlugin('ctx.js', `
import fs from 'node:fs';
export default {
  name: 'ctx-probe',
  async onInit(ctx) {
    fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
      hasConfig: !!ctx.config && typeof ctx.config === 'object',
      hasLog: typeof ctx.log?.info === 'function',
      hasDb: typeof ctx.db?.query === 'function' && typeof ctx.db?.exec === 'function',
      projectDir: ctx.projectDir,
    }));
  },
};
`);
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'loaded');
    const seen = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.equal(seen.hasConfig, true);
    assert.equal(seen.hasLog, true);
    assert.equal(seen.hasDb, true);
    assert.equal(typeof seen.projectDir, 'string');
  });
});

// ── Reload ───────────────────────────────────────────────────

describe('PluginManager: reload', () => {
  it('hot-swaps the route handler when the file changes', async () => {
    const file = writePlugin('demo.js', VALID_PLUGIN);
    await manager.loadFile(file);

    // Edit the file: v1 → v2 (also bump mtime explicitly for sub-ms file systems)
    fs.writeFileSync(file, VALID_PLUGIN.replace("msg: 'v1'", "msg: 'v2'"));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);

    const record = await manager.reload('demo');
    assert.ok(record);
    assert.equal(record.status, 'loaded');
    assert.equal(record.reloads, 1);

    const { req, res, out } = fakeReqRes();
    await matchRoute(req, res, '/api/ext/demo/hello', new URLSearchParams());
    assert.equal(JSON.parse(out.body!).msg, 'v2', 'reload must serve the NEW handler');

    // No duplicate route left behind
    const count = getRegisteredRoutes().filter(p => p === '/api/ext/demo/hello').length;
    assert.equal(count, 1);
    assert.equal(scheduler.hasHandler('demo-tick'), true, 'task re-registered after reload');
  });

  it('calls the old instance onShutdown during reload', async () => {
    const probe = path.join(tmpDir, 'shutdown-probe.txt');
    const file = writePlugin('sd.js', `
import fs from 'node:fs';
export default {
  name: 'sd',
  async onShutdown() { fs.appendFileSync(${JSON.stringify(probe)}, 'down\\n'); },
};
`);
    await manager.loadFile(file);
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);
    await manager.reload('sd');
    assert.equal(fs.readFileSync(probe, 'utf8'), 'down\n', 'old instance shut down exactly once');
  });
});

// ── Unload ───────────────────────────────────────────────────

describe('PluginManager: unload', () => {
  it('removes routes and tasks', async () => {
    const file = writePlugin('demo.js', VALID_PLUGIN);
    await manager.loadFile(file);

    const removed = await manager.unload('demo');
    assert.equal(removed, true);

    const { req, res } = fakeReqRes();
    const handled = await matchRoute(req, res, '/api/ext/demo/hello', new URLSearchParams());
    assert.equal(handled, false, 'route must be gone after unload');
    assert.equal(scheduler.hasHandler('demo-tick'), false, 'task must be gone after unload');
    assert.equal(manager.list().length, 0);
  });

  it('returns false for unknown plugin', async () => {
    assert.equal(await manager.unload('nope'), false);
  });
});

// ── Containment & rollback ───────────────────────────────────

describe('PluginManager: containment and rollback', () => {
  it('a syntactically broken file is contained as an error record', async () => {
    const file = writePlugin('broken.js', 'export default { name: "broken", ((((');
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'error');
    assert.ok(record.error);
    assert.equal(getRegisteredRoutes().length, 0, 'no routes leaked');
  });

  it('rejects routes outside the /api/ext/ namespace', async () => {
    const file = writePlugin('escape.js', `
export default {
  name: 'escape',
  routes: { '/api/todos': async () => true },
};
`);
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'error');
    assert.match(record.error!, /namespace/);
    assert.equal(getRegisteredRoutes().length, 0);
  });

  it('rolls back already-registered routes when one conflicts', async () => {
    registerRoute('/api/ext/demo2/taken', async () => true); // framework owns this one
    const file = writePlugin('demo2.js', `
export default {
  name: 'demo2',
  routes: {
    '/api/ext/demo2/free': async () => true,
    '/api/ext/demo2/taken': async () => true,
  },
};
`);
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'error');
    assert.match(record.error!, /already registered/);
    // The 'free' route must have been rolled back; only the framework route remains
    assert.deepEqual(getRegisteredRoutes(), ['/api/ext/demo2/taken']);
  });

  it('rejects a task name already registered with the scheduler', async () => {
    scheduler.addTask({ name: 'demo-tick', enabled: true, interval: '1h', config: {} });
    scheduler.registerHandler('demo-tick', async () => {});
    const file = writePlugin('demo.js', VALID_PLUGIN);
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'error');
    assert.match(record.error!, /already registered/);
    assert.equal(getRegisteredRoutes().length, 0, 'routes rolled back when task conflicts');
  });

  it('rolls back routes and tasks when onInit throws', async () => {
    const file = writePlugin('initfail.js', `
export default {
  name: 'initfail',
  routes: { '/api/ext/initfail/x': async () => true },
  tasks: [{ name: 'initfail-tick', schedule: { type: 'interval', ms: 60000 }, run: async () => {} }],
  async onInit() { throw new Error('boom'); },
};
`);
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'error');
    assert.match(record.error!, /onInit failed: boom/);
    assert.equal(getRegisteredRoutes().length, 0);
    assert.equal(scheduler.hasHandler('initfail-tick'), false);
  });

  it('a throwing route handler is contained per-request', async () => {
    const file = writePlugin('thrower.js', `
export default {
  name: 'thrower',
  routes: { '/api/ext/thrower/x': async () => { throw new Error('kaboom'); } },
};
`);
    await manager.loadFile(file);
    const { req, res, out } = fakeReqRes();
    const handled = await matchRoute(req, res, '/api/ext/thrower/x', new URLSearchParams());
    assert.equal(handled, true, 'wrapped handler reports handled');
    assert.equal(out.status, 500, 'and answers 500 instead of crashing the loop');
  });
});

// ── Scan ─────────────────────────────────────────────────────

describe('PluginManager: scan', () => {
  it('loads new files and unloads removed ones', async () => {
    const fileA = writePlugin('a.js', `export default { name: 'a', routes: { '/api/ext/a/x': async () => true } };`);
    writePlugin('b.js', `export default { name: 'b', routes: { '/api/ext/b/x': async () => true } };`);

    let records = await manager.scan();
    assert.equal(records.filter(r => r.status === 'loaded').length, 2);
    assert.equal(getRegisteredRoutes().length, 2);

    fs.unlinkSync(fileA);
    records = await manager.scan();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.name, 'b');
    assert.deepEqual(getRegisteredRoutes(), ['/api/ext/b/x']);
  });

  it('is a no-op when the directory does not exist', async () => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    const records = await manager.scan();
    assert.deepEqual(records, []);
  });

  it('rejects a duplicate plugin name from a second file', async () => {
    writePlugin('one.js', `export default { name: 'dup', routes: { '/api/ext/dup/x': async () => true } };`);
    writePlugin('two.js', `export default { name: 'dup', routes: { '/api/ext/dup/y': async () => true } };`);
    const records = await manager.scan();
    const loaded = records.filter(r => r.status === 'loaded');
    const errored = records.filter(r => r.status === 'error');
    assert.equal(loaded.length, 1, 'exactly one wins');
    assert.equal(errored.length, 1, 'the other is an error record');
    assert.match(errored[0]!.error!, /already loaded/);
  });
});

// ── Extended plugin context (Round 5b: decomposition support) ─

describe('PluginManager: extended context', () => {
  it('passes the live scheduler and supports ctx.registerCheck with auto-teardown', async () => {
    const probe = path.join(tmpDir, 'ctx2-probe.json');
    const file = writePlugin('ctx2.js', `
import fs from 'node:fs';
export default {
  name: 'ctx2',
  async onInit(ctx) {
    fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
      hasScheduler: !!ctx.scheduler && typeof ctx.scheduler.hasHandler === 'function',
      hasImport: typeof ctx.import === 'function',
      hasRegisterAdapter: typeof ctx.registerAdapter === 'function',
    }));
    ctx.registerCheck('ctx2-check', () => ({ ok: true, message: 'fine' }));
  },
};
`);
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'loaded');
    assert.deepEqual(record.checks, ['ctx2-check']);

    const seen = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.equal(seen.hasScheduler, true);
    assert.equal(seen.hasImport, true);
    assert.equal(seen.hasRegisterAdapter, true);

    const { getRegisteredChecks } = await import('../extended-status.js');
    assert.ok(getRegisteredChecks().includes('ctx2-check'));

    await manager.unload('ctx2');
    assert.ok(!getRegisteredChecks().includes('ctx2-check'), 'check removed on unload');
  });

  it('ctx.import loads framework modules cache-busted and rejects path escape', async () => {
    const probe = path.join(tmpDir, 'imp-probe.json');
    const file = writePlugin('imp.js', `
import fs from 'node:fs';
export default {
  name: 'imp',
  async onInit(ctx) {
    const routeRegistry = await ctx.import('core/route-registry.js');
    let escaped = false;
    try { await ctx.import('../../../etc/passwd'); } catch { escaped = true; }
    fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
      gotModule: typeof routeRegistry.registerRoute === 'function',
      escapeRejected: escaped,
    }));
  },
};
`);
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'loaded');
    const seen = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.equal(seen.gotModule, true, 'ctx.import resolves dist-relative framework modules');
    assert.equal(seen.escapeRejected, true, 'path traversal outside dist is rejected');
  });

  it('adapters registered via ctx are unregistered on unload', async () => {
    const file = writePlugin('adp.js', `
export default {
  name: 'adp',
  async onInit(ctx) {
    ctx.registerAdapter({
      name: 'adp-test-channel',
      send: async () => ({ ok: true }),
    });
  },
};
`);
    const record = await manager.loadFile(file);
    assert.equal(record.status, 'loaded');
    assert.deepEqual(record.adapters, ['adp-test-channel']);

    const { getAdapter } = await import('../../comms/channel-router.js');
    assert.ok(getAdapter('adp-test-channel'), 'adapter registered');

    await manager.unload('adp');
    assert.equal(getAdapter('adp-test-channel'), undefined, 'adapter removed on unload');
  });
});

// ── The real Granola plugin (decomposition proof) ────────────

describe('Granola plugin: the peeled monolith component loads via ctx.import', () => {
  it('loads the actual .kithkit/extensions/granola.js against compiled modules', async () => {
    // Repo root is four levels up from daemon/dist/core/__tests__/
    const repoRoot = path.resolve(import.meta.dirname, '../../../../');
    const granolaPlugin = path.join(repoRoot, '.kithkit', 'extensions', 'granola.js');
    assert.ok(fs.existsSync(granolaPlugin), 'granola plugin file must exist in the repo');

    // Granola is not enabled in this test config, so its init self-gates and
    // returns early — what this proves is the WIRING: the plugin file parses,
    // ctx.import resolves the compiled component, and init/shutdown round-trip.
    const record = await manager.loadFile(granolaPlugin);
    assert.equal(record.status, 'loaded', `granola plugin should load (error: ${record.error})`);
    assert.equal(record.name, 'granola');

    const removed = await manager.unload('granola');
    assert.equal(removed, true, 'granola plugin unloads cleanly');
  });
});
