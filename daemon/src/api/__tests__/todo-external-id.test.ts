/**
 * Tests for bug #1820: POST and PUT /api/todos persisting external_id and source.
 *
 * Covers:
 *   (a) POST persists external_id + source and reads them back
 *   (b) PUT updates external_id + source and reads them back
 *   (c) PUT to a todo with external_id=null still applies other field updates (#1812 regression)
 *   (d) duplicate non-null external_id → 409, not 500
 *   (e) multiple NULL external_ids → both created (SQLite UNIQUE allows multiple NULLs)
 *   (f) end-to-end: POST → GET → PUT → GET proof
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { handleStateRoute } from '../state.js';

const TEST_PORT = 19922;

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

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-todo-eid-'));
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

// ── (a) POST persists external_id + source ───────────────────────────────────

describe('bug#1820 POST /api/todos — persists external_id and source', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('POST with external_id + source returns them in the 201 body and readback GET', async () => {
    const postRes = await request('POST', '/api/todos', {
      title: 'SN-linked todo',
      external_id: 'SN-001',
      source: 'servicenow',
    });
    assert.equal(postRes.status, 201, `Expected 201, got ${postRes.status}: ${postRes.body}`);
    const created = JSON.parse(postRes.body) as { id: number; external_id: string | null; source: string | null };
    assert.equal(created.external_id, 'SN-001', 'POST response must include external_id');
    assert.equal(created.source, 'servicenow', 'POST response must include source');

    const getRes = await request('GET', `/api/todos/${created.id}`);
    assert.equal(getRes.status, 200);
    const fetched = JSON.parse(getRes.body) as { external_id: string | null; source: string | null };
    assert.equal(fetched.external_id, 'SN-001', 'GET readback must return stored external_id');
    assert.equal(fetched.source, 'servicenow', 'GET readback must return stored source');
  });
});

// ── (b) PUT updates external_id + source ────────────────────────────────────

describe('bug#1820 PUT /api/todos/:id — updates external_id and source', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('PUT sets external_id + source on an existing todo and GET reads them back', async () => {
    const postRes = await request('POST', '/api/todos', { title: 'Todo to link' });
    assert.equal(postRes.status, 201);
    const created = JSON.parse(postRes.body) as { id: number; external_id: string | null };
    assert.equal(created.external_id, null, 'New todo should have null external_id');

    const putRes = await request('PUT', `/api/todos/${created.id}`, {
      external_id: 'SN-999',
      source: 'servicenow',
    });
    assert.equal(putRes.status, 200, `PUT failed: ${putRes.body}`);
    const putBody = JSON.parse(putRes.body) as { external_id: string | null; source: string | null };
    assert.equal(putBody.external_id, 'SN-999', 'PUT response must return updated external_id');
    assert.equal(putBody.source, 'servicenow', 'PUT response must return updated source');

    const getRes = await request('GET', `/api/todos/${created.id}`);
    assert.equal(getRes.status, 200);
    const fetched = JSON.parse(getRes.body) as { external_id: string | null; source: string | null };
    assert.equal(fetched.external_id, 'SN-999', 'GET after PUT must return persisted external_id');
    assert.equal(fetched.source, 'servicenow', 'GET after PUT must return persisted source');
  });
});

// ── (c) PUT to null-external_id todo applies other updates (#1812 regression) ─

describe('bug#1812 regression — PUT to todo with null external_id applies field updates', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('PUT status/description on a null-external_id todo updates those fields', async () => {
    const postRes = await request('POST', '/api/todos', { title: 'Plain todo', priority: 'low' });
    assert.equal(postRes.status, 201);
    const created = JSON.parse(postRes.body) as { id: number; external_id: string | null; status: string };
    assert.equal(created.external_id, null, 'Precondition: todo has null external_id');
    assert.equal(created.status, 'pending');

    const putRes = await request('PUT', `/api/todos/${created.id}`, {
      status: 'in_progress',
      description: 'Now in progress',
    });
    assert.equal(putRes.status, 200, `PUT failed: ${putRes.body}`);

    const getRes = await request('GET', `/api/todos/${created.id}`);
    const fetched = JSON.parse(getRes.body) as { status: string; description: string | null };
    assert.equal(fetched.status, 'in_progress', 'status must be updated for null-external_id todo');
    assert.equal(fetched.description, 'Now in progress', 'description must be updated for null-external_id todo');
  });
});

// ── (d) duplicate non-null external_id → 409 ────────────────────────────────

describe('bug#1820 — duplicate non-null external_id returns 409 not 500', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('POST with duplicate external_id returns 409', async () => {
    const first = await request('POST', '/api/todos', { title: 'First', external_id: 'SN-DUP' });
    assert.equal(first.status, 201, `First create failed: ${first.body}`);

    const second = await request('POST', '/api/todos', { title: 'Second', external_id: 'SN-DUP' });
    assert.equal(second.status, 409, `Expected 409 for duplicate external_id, got ${second.status}: ${second.body}`);
    const errBody = JSON.parse(second.body) as { error: string };
    assert.ok(errBody.error.includes('external_id'), 'Error message should mention external_id');
  });

  it('PUT that sets a duplicate external_id returns 409', async () => {
    const first = await request('POST', '/api/todos', { title: 'First', external_id: 'SN-PUTDUP' });
    assert.equal(first.status, 201);
    const second = await request('POST', '/api/todos', { title: 'Second' });
    assert.equal(second.status, 201);
    const secondId = (JSON.parse(second.body) as { id: number }).id;

    const putRes = await request('PUT', `/api/todos/${secondId}`, { external_id: 'SN-PUTDUP' });
    assert.equal(putRes.status, 409, `Expected 409 for duplicate external_id on PUT, got ${putRes.status}: ${putRes.body}`);
  });
});

// ── (e) multiple NULL external_ids allowed ───────────────────────────────────

describe('bug#1820 — multiple todos with null external_id are allowed', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('POST two todos without external_id both succeed', async () => {
    const first = await request('POST', '/api/todos', { title: 'First null-eid' });
    assert.equal(first.status, 201, `First create failed: ${first.body}`);

    const second = await request('POST', '/api/todos', { title: 'Second null-eid' });
    assert.equal(second.status, 201, `Second create should also succeed: ${second.body}`);

    const firstBody = JSON.parse(first.body) as { external_id: string | null };
    const secondBody = JSON.parse(second.body) as { external_id: string | null };
    assert.equal(firstBody.external_id, null);
    assert.equal(secondBody.external_id, null);
  });
});

// ── (f) end-to-end: POST → GET → PUT → GET ───────────────────────────────────

describe('bug#1820 end-to-end proof: POST → GET → PUT → GET', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('full cycle: create with external_id, read back, update source, read back again', async () => {
    // Step 1: POST with external_id
    const postRes = await request('POST', '/api/todos', {
      title: 'E2E todo',
      external_id: 'SN-E2E-001',
    });
    assert.equal(postRes.status, 201);
    const created = JSON.parse(postRes.body) as { id: number; external_id: string | null; source: string | null };
    assert.equal(created.external_id, 'SN-E2E-001', 'POST: external_id must be in response');
    assert.equal(created.source, null, 'POST: source is null initially');

    // Step 2: GET to verify persistence
    const getRes1 = await request('GET', `/api/todos/${created.id}`);
    assert.equal(getRes1.status, 200);
    const fetched1 = JSON.parse(getRes1.body) as { external_id: string | null; source: string | null };
    assert.equal(fetched1.external_id, 'SN-E2E-001', 'GET: external_id persisted from POST');

    // Step 3: PUT to add source
    const putRes = await request('PUT', `/api/todos/${created.id}`, {
      source: 'servicenow',
      status: 'in_progress',
    });
    assert.equal(putRes.status, 200);
    const putBody = JSON.parse(putRes.body) as {
      external_id: string | null;
      source: string | null;
      status: string;
    };
    assert.equal(putBody.external_id, 'SN-E2E-001', 'PUT response: external_id unchanged');
    assert.equal(putBody.source, 'servicenow', 'PUT response: source updated');
    assert.equal(putBody.status, 'in_progress', 'PUT response: status updated');

    // Step 4: GET to verify PUT persistence
    const getRes2 = await request('GET', `/api/todos/${created.id}`);
    assert.equal(getRes2.status, 200);
    const fetched2 = JSON.parse(getRes2.body) as {
      external_id: string | null;
      source: string | null;
      status: string;
    };
    assert.equal(fetched2.external_id, 'SN-E2E-001', 'GET after PUT: external_id still correct');
    assert.equal(fetched2.source, 'servicenow', 'GET after PUT: source persisted');
    assert.equal(fetched2.status, 'in_progress', 'GET after PUT: status persisted');
  });
});
