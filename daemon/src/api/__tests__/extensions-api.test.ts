/**
 * Extensions management API — load-authorization gate (R2 security review).
 *
 * Plugin load executes code in the daemon process, so mutating endpoints are
 * an arbitrary-code-load surface: localhost reachability must NOT be enough.
 * Mutations require a comms/daemon-role token; reads stay open.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { issueToken } from '../../auth/agent-tokens.js';
import { initPluginManager, _resetPluginManagerForTesting } from '../../core/plugin-extensions.js';
import { _resetRoutesForTesting } from '../../core/route-registry.js';
import { handleExtensionsRoute } from '../extensions.js';

let tmpDir: string;

function fakeReqRes(method: string, headers: Record<string, string> = {}): {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  out: { status?: number; body?: string };
} {
  const out: { status?: number; body?: string } = {};
  const req = { method, headers } as unknown as http.IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(status: number) { out.status = status; return this; },
    end(body?: string) { out.body = body; },
  } as unknown as http.ServerResponse;
  return { req, res, out };
}

beforeEach(() => {
  _resetConfigForTesting();
  _resetDbForTesting();
  _resetRoutesForTesting();
  _resetPluginManagerForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-ext-api-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  const pluginsDir = path.join(tmpDir, 'extensions');
  fs.mkdirSync(pluginsDir);
  initPluginManager({ dir: pluginsDir, config: loadConfig(tmpDir), getScheduler: () => null });
});

afterEach(() => {
  _resetPluginManagerForTesting();
  _resetRoutesForTesting();
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extensions API: load-authorization gate', () => {
  it('rejects mutating calls without a token (401)', async () => {
    const { req, res, out } = fakeReqRes('POST');
    const handled = await handleExtensionsRoute(req, res, '/api/extensions/scan');
    assert.equal(handled, true);
    assert.equal(out.status, 401);
  });

  it('rejects worker-role tokens (403) — workers cannot trigger code load', async () => {
    const token = issueToken('worker', { jobId: 'job-123' });
    const { req, res, out } = fakeReqRes('POST', { 'x-agent-token': token });
    const handled = await handleExtensionsRoute(req, res, '/api/extensions/scan');
    assert.equal(handled, true);
    assert.equal(out.status, 403);
  });

  it('rejects orchestrator-role tokens (403)', async () => {
    const token = issueToken('orchestrator');
    const { req, res, out } = fakeReqRes('POST', { 'x-agent-token': token });
    const handled = await handleExtensionsRoute(req, res, '/api/extensions/scan');
    assert.equal(out.status, 403);
    assert.equal(handled, true);
  });

  it('accepts comms-role tokens for scan', async () => {
    const token = issueToken('comms');
    const { req, res, out } = fakeReqRes('POST', { 'x-agent-token': token });
    const handled = await handleExtensionsRoute(req, res, '/api/extensions/scan');
    assert.equal(handled, true);
    assert.equal(out.status, 200);
  });

  it('accepts daemon-role tokens for reload (404 for unknown plugin, but past the gate)', async () => {
    const token = issueToken('daemon');
    const { req, res, out } = fakeReqRes('POST', { 'x-agent-token': token });
    const handled = await handleExtensionsRoute(req, res, '/api/extensions/nope/reload');
    assert.equal(handled, true);
    assert.equal(out.status, 404, 'gate passed; plugin lookup 404s');
  });

  it('gates DELETE the same way', async () => {
    const { req, res, out } = fakeReqRes('DELETE');
    const handled = await handleExtensionsRoute(req, res, '/api/extensions/anything');
    assert.equal(handled, true);
    assert.equal(out.status, 401);
  });

  it('leaves GET (read-only status) open', async () => {
    const { req, res, out } = fakeReqRes('GET');
    const handled = await handleExtensionsRoute(req, res, '/api/extensions');
    assert.equal(handled, true);
    assert.equal(out.status, 200);
    const body = JSON.parse(out.body!);
    assert.ok(Array.isArray(body.plugins));
  });
});

describe('extensions API: path leak prevention (R2 hardening #2)', () => {
  it('GET /api/extensions does not leak plugins_dir absolute path', async () => {
    const { req, res, out } = fakeReqRes('GET');
    await handleExtensionsRoute(req, res, '/api/extensions');
    const body = JSON.parse(out.body!);
    // plugins_dir (absolute path) must not be present
    assert.equal(body.plugins_dir, undefined, 'plugins_dir absolute path must not be in response');
    // plugins_dir_configured is the safe replacement (boolean)
    assert.ok('plugins_dir_configured' in body, 'plugins_dir_configured boolean must be present');
    assert.equal(typeof body.plugins_dir_configured, 'boolean');
  });

  it('GET /api/extensions plugin file fields contain no absolute paths', async () => {
    // Write a minimal valid plugin file into the tmpDir plugins dir so list() has something
    const pluginSrc = `export default { name: 'leak-test-plugin', routes: {}, tasks: [] };`;
    const pluginsDir = path.join(tmpDir, 'extensions');
    const pluginFile = path.join(pluginsDir, 'leak-test-plugin.mjs');
    fs.writeFileSync(pluginFile, pluginSrc);

    const { req, res, out } = fakeReqRes('GET');
    await handleExtensionsRoute(req, res, '/api/extensions');
    const body = JSON.parse(out.body!);
    assert.ok(Array.isArray(body.plugins));
    for (const plugin of body.plugins) {
      assert.ok(
        typeof plugin.file === 'string' && !plugin.file.startsWith('/'),
        `plugin.file must not be an absolute path; got: ${plugin.file}`,
      );
    }
  });

  it('GET /api/extensions response contains no string values starting with / (full path scan)', async () => {
    const { req, res, out } = fakeReqRes('GET');
    await handleExtensionsRoute(req, res, '/api/extensions');
    const body = JSON.parse(out.body!);

    function collectStrings(val: unknown): string[] {
      if (typeof val === 'string') return [val];
      if (Array.isArray(val)) return val.flatMap(collectStrings);
      if (val && typeof val === 'object') return Object.values(val).flatMap(collectStrings);
      return [];
    }

    const allStrings = collectStrings(body);
    const absolutePaths = allStrings.filter(s => s.startsWith('/'));
    assert.deepEqual(
      absolutePaths,
      [],
      `Response must not contain absolute paths; found: ${JSON.stringify(absolutePaths)}`,
    );
  });
});
