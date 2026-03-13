/**
 * t-122, t-123, t-124, t-125, t-176: Daemon API — state endpoints
 *
 * Uses a shared DB singleton so must run sequentially (concurrency: 1).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../core/db.js';
import { handleStateRoute } from '../api/state.js';
import { handleAgentsRoute } from '../api/agents.js';

const TEST_PORT = 19860;

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

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-state-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleAgentsRoute(inReq, res, url.pathname)
      .then((handled) => {
        if (handled) return;
        return handleStateRoute(inReq, res, url.pathname, url.searchParams);
      })
      .then((handled) => {
        if (handled === false) {
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

// Top-level sequential wrapper — needed because all describes share the DB singleton
describe('State API', { concurrency: 1 }, () => {

  // ── t-122: Todo CRUD via API ──────────────────────────────────

  describe('Todo CRUD (t-122)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates a todo via POST', async () => {
      const res = await request('POST', '/api/todos', { title: 'Test todo', priority: 'high' });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.id, 'Should have an id');
      assert.equal(body.title, 'Test todo');
      assert.equal(body.priority, 'high');
      assert.ok(body.timestamp, 'Response should include timestamp');
      assert.ok(body.created_at, 'Should have created_at');
    });

    it('lists todos via GET', async () => {
      await request('POST', '/api/todos', { title: 'Todo 1' });
      await request('POST', '/api/todos', { title: 'Todo 2' });
      const res = await request('GET', '/api/todos');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.timestamp);
      assert.equal(body.data.length, 2);
    });

    it('updates a todo via PUT', async () => {
      const created = JSON.parse((await request('POST', '/api/todos', { title: 'Update me' })).body);
      const res = await request('PUT', `/api/todos/${created.id}`, { status: 'completed' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'completed');
      assert.ok(body.timestamp);
      assert.notEqual(body.updated_at, body.created_at);
    });

    it('deletes a todo via DELETE, subsequent GET returns 404', async () => {
      const created = JSON.parse((await request('POST', '/api/todos', { title: 'Delete me' })).body);
      const delRes = await request('DELETE', `/api/todos/${created.id}`);
      assert.equal(delRes.status, 204);

      const getRes = await request('GET', `/api/todos/${created.id}`);
      assert.equal(getRes.status, 404);
    });

    it('auto-creates todo_actions audit trail', async () => {
      const created = JSON.parse((await request('POST', '/api/todos', { title: 'Audited' })).body);
      await request('PUT', `/api/todos/${created.id}`, { status: 'completed' });

      const actionsRes = await request('GET', `/api/todos/${created.id}/actions`);
      assert.equal(actionsRes.status, 200);
      const actions = JSON.parse(actionsRes.body);
      assert.ok(actions.data.length >= 2, 'Should have create + status_change actions');
      assert.equal(actions.data[0].action, 'created');
      assert.equal(actions.data[1].action, 'status_change');
      assert.equal(actions.data[1].old_value, 'pending');
      assert.equal(actions.data[1].new_value, 'completed');
    });
  });

  // ── t-123: Calendar CRUD via API ─────────────────────────────

  describe('Calendar CRUD (t-123)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates a calendar event via POST', async () => {
      const res = await request('POST', '/api/calendar', {
        title: 'Meeting',
        start_time: '2026-02-23T10:00:00Z',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.id);
      assert.equal(body.title, 'Meeting');
      assert.ok(body.timestamp);
    });

    it('lists events filtered by date', async () => {
      await request('POST', '/api/calendar', { title: 'Event 1', start_time: '2026-02-23T10:00:00Z' });
      await request('POST', '/api/calendar', { title: 'Event 2', start_time: '2026-02-24T10:00:00Z' });
      const res = await request('GET', '/api/calendar?date=2026-02-23');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].title, 'Event 1');
    });

    it('updates a calendar event via PUT', async () => {
      const created = JSON.parse((await request('POST', '/api/calendar', {
        title: 'Meeting',
        start_time: '2026-02-23T10:00:00Z',
      })).body);
      const res = await request('PUT', `/api/calendar/${created.id}`, { end_time: '2026-02-23T11:00:00Z' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.end_time, '2026-02-23T11:00:00Z');
    });

    it('deletes a calendar event via DELETE', async () => {
      const created = JSON.parse((await request('POST', '/api/calendar', {
        title: 'Delete me',
        start_time: '2026-02-23T10:00:00Z',
      })).body);
      const res = await request('DELETE', `/api/calendar/${created.id}`);
      assert.equal(res.status, 204);
    });
  });

  // ── t-124: Config and feature_state via API ──────────────────

  describe('Config and feature_state (t-124)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('sets and gets config via PUT/GET', async () => {
      const putRes = await request('PUT', '/api/config/theme', { value: 'dark' });
      assert.equal(putRes.status, 200);
      const putBody = JSON.parse(putRes.body);
      assert.equal(putBody.key, 'theme');
      assert.equal(putBody.value, 'dark');

      const getRes = await request('GET', '/api/config/theme');
      assert.equal(getRes.status, 200);
      const getBody = JSON.parse(getRes.body);
      assert.equal(getBody.key, 'theme');
      assert.equal(getBody.value, 'dark');
      assert.ok(getBody.updated_at);
      assert.ok(getBody.timestamp);
    });

    it('sets and gets feature state via PUT/GET', async () => {
      const putRes = await request('PUT', '/api/feature-state/onboarding', {
        state: { step: 3, completed: false },
      });
      assert.equal(putRes.status, 200);
      const putBody = JSON.parse(putRes.body);
      assert.equal(putBody.feature, 'onboarding');
      assert.deepEqual(putBody.state, { step: 3, completed: false });

      const getRes = await request('GET', '/api/feature-state/onboarding');
      assert.equal(getRes.status, 200);
      const getBody = JSON.parse(getRes.body);
      assert.deepEqual(getBody.state, { step: 3, completed: false });
    });

    it('returns 404 for missing config key', async () => {
      const res = await request('GET', '/api/config/nonexistent');
      assert.equal(res.status, 404);
    });

    it('returns 404 for missing feature state', async () => {
      const res = await request('GET', '/api/feature-state/nonexistent');
      assert.equal(res.status, 404);
    });
  });

  // ── t-125: API responses include timestamp and proper error codes ──

  describe('Timestamps and errors (t-125)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('successful responses include timestamp field', async () => {
      const res = await request('POST', '/api/todos', { title: 'Timestamp test' });
      const body = JSON.parse(res.body);
      assert.ok(body.timestamp, 'Response should have timestamp');
      assert.ok(!isNaN(Date.parse(body.timestamp)), 'Timestamp should be valid ISO 8601');
    });

    it('returns 404 with timestamp for missing todo', async () => {
      const res = await request('GET', '/api/todos/99999');
      assert.equal(res.status, 404);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'Not found');
      assert.ok(body.timestamp);
    });

    it('returns 400 with timestamp for missing title', async () => {
      const res = await request('POST', '/api/todos', {});
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'title is required');
      assert.ok(body.timestamp);
    });

    it('all responses include X-Timestamp header', async () => {
      const res = await request('GET', '/api/todos');
      assert.ok(res.headers['x-timestamp'], 'Should have X-Timestamp header');
    });
  });

  // ── t-176: Negative: API rejects invalid todo input ──────────

  describe('Invalid todo input (t-176)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('rejects POST with empty body (missing title)', async () => {
      const res = await request('POST', '/api/todos', {});
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'title is required');
    });

    it('rejects invalid priority', async () => {
      const res = await request('POST', '/api/todos', { title: 'test', priority: 'super-urgent' });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('invalid priority'));
    });

    it('returns 404 when updating nonexistent todo', async () => {
      const res = await request('PUT', '/api/todos/999999', { title: 'nope' });
      assert.equal(res.status, 404);
    });

    it('returns 400 for malformed JSON without crashing', async () => {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = http.request({
          host: '127.0.0.1',
          port: TEST_PORT,
          path: '/api/todos',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        r.on('error', reject);
        r.write('{invalid json!!!');
        r.end();
      });

      assert.equal(result.status, 400);
      const body = JSON.parse(result.body);
      assert.ok(body.error, 'Should have error message');
      assert.ok(body.timestamp, 'Error should include timestamp');

      // Verify server still works after bad JSON
      const healthy = await request('GET', '/api/todos');
      assert.equal(healthy.status, 200);
    });
  });

  // ── Agents list (part of t-125 acceptance criteria) ──────────

  describe('Agents list', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns empty agent list', async () => {
      const res = await request('GET', '/api/agents');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.ok(body.timestamp);
    });
  });

  // ── Todo query filters ───────────────────────────────────────

  describe('Todo query filters', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('filters todos by ?status= query parameter', async () => {
      await request('POST', '/api/todos', { title: 'Pending task' });
      const created = JSON.parse((await request('POST', '/api/todos', { title: 'Done task' })).body);
      await request('PUT', `/api/todos/${created.id}`, { status: 'completed' });

      const allRes = await request('GET', '/api/todos');
      assert.equal(JSON.parse(allRes.body).data.length, 2, 'Should have 2 total todos');

      const pendingRes = await request('GET', '/api/todos?status=pending');
      assert.equal(pendingRes.status, 200);
      const pendingBody = JSON.parse(pendingRes.body);
      assert.equal(pendingBody.data.length, 1, 'Should have 1 pending todo');
      assert.equal(pendingBody.data[0].title, 'Pending task');
      assert.equal(pendingBody.data[0].status, 'pending');

      const completedRes = await request('GET', '/api/todos?status=completed');
      const completedBody = JSON.parse(completedRes.body);
      assert.equal(completedBody.data.length, 1, 'Should have 1 completed todo');
      assert.equal(completedBody.data[0].title, 'Done task');
    });

    it('filters todos by ?priority= query parameter', async () => {
      await request('POST', '/api/todos', { title: 'High priority', priority: 'high' });
      await request('POST', '/api/todos', { title: 'Low priority', priority: 'low' });
      await request('POST', '/api/todos', { title: 'Also low', priority: 'low' });

      const highRes = await request('GET', '/api/todos?priority=high');
      assert.equal(highRes.status, 200);
      const highBody = JSON.parse(highRes.body);
      assert.equal(highBody.data.length, 1, 'Should have 1 high priority todo');
      assert.equal(highBody.data[0].title, 'High priority');

      const lowRes = await request('GET', '/api/todos?priority=low');
      const lowBody = JSON.parse(lowRes.body);
      assert.equal(lowBody.data.length, 2, 'Should have 2 low priority todos');
    });

    it('ignores invalid filter values', async () => {
      await request('POST', '/api/todos', { title: 'A todo' });

      const res = await request('GET', '/api/todos?status=bogus');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1, 'Invalid filter should be ignored, returning all todos');
    });

    it('combines status and priority filters', async () => {
      await request('POST', '/api/todos', { title: 'High pending', priority: 'high' });
      await request('POST', '/api/todos', { title: 'Low pending', priority: 'low' });
      const created = JSON.parse((await request('POST', '/api/todos', { title: 'High done', priority: 'high' })).body);
      await request('PUT', `/api/todos/${created.id}`, { status: 'completed' });

      const res = await request('GET', '/api/todos?status=pending&priority=high');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1, 'Should match only high+pending');
      assert.equal(body.data[0].title, 'High pending');
    });
  });

  // ── Usage endpoint ───────────────────────────────────────────

  describe('Usage endpoint', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns zero usage when no worker jobs', async () => {
      const res = await request('GET', '/api/usage');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.tokens_in, 0);
      assert.equal(body.tokens_out, 0);
      assert.equal(body.cost_usd, 0);
      assert.equal(body.jobs, 0);
      assert.ok(body.timestamp);
    });
  });
});
