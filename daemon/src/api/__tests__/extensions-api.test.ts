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
