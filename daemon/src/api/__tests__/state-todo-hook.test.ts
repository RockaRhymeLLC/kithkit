/**
 * FABLE-5 / R2: Mutation-killing tests for the todo-update hook in state.ts.
 *
 * Assertion (1) — hook fires:
 *   Register a _todoUpdateHook, do a todo PUT, assert the hook was called with
 *   the correct (internalId, changes) args.
 *   MUTATION-KILLING: removing the hook-call block at state.ts:351-358 leaves
 *   hookFired=false → assert.ok(hookFired) FAILS.
 *
 * Assertion (2) — error swallowing:
 *   Register a THROWING _todoUpdateHook, do a todo PUT, assert PUT returns 200.
 *   MUTATION-KILLING: removing the try/catch at state.ts:352-358 lets the error
 *   propagate to the outer catch which re-throws, causing the test server to
 *   respond 500 → assert.equal(status, 200) FAILS.
 *
 * No new seam required — registerTodoUpdateHook is already exported by state.ts.
 * registerTodoUpdateHook(fn) overwrites any previous hook, so each test installs
 * its own hook before the PUT; module-level state does not leak between suites.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { handleStateRoute, registerTodoUpdateHook } from '../state.js';

// Unique port — no conflict with other __tests__ suites (19871-19894, 19897).
const TEST_PORT = 19895;

// ── HTTP helper ────────────────────────────────────────────────────────────────

function request(
  method: string,
  urlPath: string,
  body?: unknown,
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

// ── Test infrastructure ────────────────────────────────────────────────────────

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-state-hook-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    handleStateRoute(inReq, res, url.pathname, url.searchParams)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found', timestamp: new Date().toISOString() }));
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err), timestamp: new Date().toISOString() }));
        }
      });
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    if (server?.listening) {
      server.close(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    } else {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }
  });
}

// ── Assertion (1): hook fires ──────────────────────────────────────────────────

describe('state.ts todo-update hook — fires on PUT with correct args', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('calls the registered hook with (internalId, changes) after a todo PUT', async () => {
    // Seed: create a todo via the shim.
    const createRes = await request('POST', '/api/todos', { title: 'Hook target todo' });
    assert.equal(createRes.status, 201);
    const created = JSON.parse(createRes.body) as { id: number };
    const todoId = created.id;

    // Install tracking hook.
    let hookFired = false;
    let hookId = -1;
    let hookChanges: Record<string, unknown> = {};
    registerTodoUpdateHook((id, changes) => {
      hookFired = true;
      hookId = id;
      hookChanges = changes;
    });

    // Perform the PUT.
    const putRes = await request('PUT', `/api/todos/${todoId}`, { title: 'Updated title' });
    assert.equal(putRes.status, 200, 'PUT should succeed');

    // MUTATION-KILLING (1): removing the hook-call block (state.ts:351-358) keeps
    // hookFired=false → this assertion FAILS, catching the silent regression.
    assert.ok(hookFired, 'Hook must have been called by the PUT handler');
    assert.equal(hookId, todoId, 'Hook must receive the correct internal ID');
    assert.equal(
      hookChanges.title,
      'Updated title',
      'Hook changes must include the updated title field',
    );
  });
});

// ── Assertion (2): throwing hook does not fail PUT ────────────────────────────

describe('state.ts todo-update hook — throwing hook does not fail PUT', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('PUT returns 200 even when the registered hook throws', async () => {
    // Seed: create a todo via the shim.
    const createRes = await request('POST', '/api/todos', { title: 'Resilience test todo' });
    assert.equal(createRes.status, 201);
    const created = JSON.parse(createRes.body) as { id: number };
    const todoId = created.id;

    // Install a hook that always throws.
    registerTodoUpdateHook((_id, _changes) => {
      throw new Error('Simulated hook failure');
    });

    // MUTATION-KILLING (2): removing the try/catch (state.ts:352-358) lets the
    // error propagate to handleStateRoute's outer catch (line 630), which
    // re-throws (not 'Request body too large' / 'Invalid JSON'), so the test
    // server's .catch writes 500 → assert.equal(status, 200) FAILS, catching
    // the regression where a hook error could break every todo PUT.
    const putRes = await request('PUT', `/api/todos/${todoId}`, { status: 'in_progress' });
    assert.equal(putRes.status, 200, 'PUT must return 200 even when the hook throws');

    // Sanity: DB update must have been committed despite the hook error.
    const getRes = await request('GET', `/api/todos/${todoId}`);
    assert.equal(getRes.status, 200);
    const getBody = JSON.parse(getRes.body) as { status: string };
    assert.equal(getBody.status, 'in_progress', 'DB update must be committed despite hook error');
  });
});
