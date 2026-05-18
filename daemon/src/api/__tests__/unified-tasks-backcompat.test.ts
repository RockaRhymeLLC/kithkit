/**
 * T3: Back-compat tests for /api/todos and /api/orchestrator/tasks shims.
 *
 * Both shims now read from and write to the unified `tasks` table.
 * These tests verify:
 *   - /api/todos only sees kind='todo' rows
 *   - /api/orchestrator/tasks only sees kind='orchestrator' rows
 *   - Response shapes are preserved (integer id for todos, UUID id for orch tasks)
 *   - The two namespaces don't bleed into each other
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { handleStateRoute } from '../state.js';
import { handleTaskQueueRoute, _setEvaluateTaskFnForTesting } from '../task-queue.js';

const TODO_PORT = 19891;
const ORCH_PORT = 19892;

// ── Request helpers ────────────────────────────────────────────

function makeTodoRequest(method: string, urlPath: string, body?: unknown) {
  return makeRequest(TODO_PORT, method, urlPath, body);
}

function makeOrchRequest(method: string, urlPath: string, body?: unknown) {
  return makeRequest(ORCH_PORT, method, urlPath, body);
}

function makeRequest(port: number, method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port,
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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ── Test servers ───────────────────────────────────────────────

let todoServer: http.Server;
let orchServer: http.Server;
let tmpDir: string;

function makeHandler(
  handlerFn: (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, sp: URLSearchParams) => Promise<boolean>,
  port: number,
): http.Server {
  return http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${port}`);
    handlerFn(inReq, res, url.pathname, url.searchParams)
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
}

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-backcompat-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Mock evaluateTask to avoid spawning real workers
  _setEvaluateTaskFnForTesting(async () => {});

  todoServer = makeHandler(handleStateRoute, TODO_PORT);
  orchServer = makeHandler(handleTaskQueueRoute, ORCH_PORT);

  return new Promise<void>((resolve) => {
    todoServer.listen(TODO_PORT, '127.0.0.1', () => {
      orchServer.listen(ORCH_PORT, '127.0.0.1', resolve);
    });
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    orchServer.close(() => {
      todoServer.close(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    });
  });
}

// ── /api/todos shim ────────────────────────────────────────────

describe('/api/todos back-compat shim', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('POST /api/todos creates a task with kind=todo', async () => {
    const res = await makeTodoRequest('POST', '/api/todos', {
      title: 'Buy groceries',
      priority: 'medium',
    });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'todo');
    assert.equal(body.title, 'Buy groceries');
    assert.equal(body.priority, 'medium');
    assert.equal(body.status, 'pending');
  });

  it('GET /api/todos returns only kind=todo tasks', async () => {
    // Create one todo and one orchestrator task
    await makeTodoRequest('POST', '/api/todos', { title: 'Todo task' });
    await makeOrchRequest('POST', '/api/orchestrator/tasks', { title: 'Orch task' });

    const res = await makeTodoRequest('GET', '/api/todos');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data), 'data should be array');
    assert.equal(body.data.length, 1, 'should only return 1 todo, not the orch task');
    assert.equal(body.data[0].title, 'Todo task');
    assert.equal(body.data[0].kind, 'todo');
  });

  it('GET /api/todos response shape has id (integer), title, priority, status, due_date', async () => {
    await makeTodoRequest('POST', '/api/todos', {
      title: 'Shape check',
      priority: 'high',
      due_date: '2026-12-31',
    });

    const res = await makeTodoRequest('GET', '/api/todos');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    const todo = body.data[0];

    assert.ok(typeof todo.id === 'number', 'id should be integer');
    assert.ok(typeof todo.title === 'string', 'title should be string');
    assert.ok(typeof todo.priority === 'string', 'priority should be string');
    assert.ok(typeof todo.status === 'string', 'status should be string');
    assert.equal(todo.due_date, '2026-12-31');
  });

  it('GET /api/todos does not return orchestrator-specific fields in unexpected way', async () => {
    await makeTodoRequest('POST', '/api/todos', { title: 'Field check' });

    const res = await makeTodoRequest('GET', '/api/todos');
    const body = JSON.parse(res.body);
    const todo = body.data[0];

    // Todos should not have orchestrator UUID ids
    assert.equal(todo.external_id, null, 'todos have null external_id');
  });
});

// ── /api/orchestrator/tasks shim ──────────────────────────────

describe('/api/orchestrator/tasks back-compat shim', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('POST /api/orchestrator/tasks creates a task with kind=orchestrator', async () => {
    const res = await makeOrchRequest('POST', '/api/orchestrator/tasks', {
      title: 'Orch task',
    });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.id, 'id should be present');
    assert.ok(/^[0-9a-f-]{36}$/.test(body.id), 'id should be UUID for orch task');
    assert.equal(body.title, 'Orch task');
    assert.equal(body.status, 'pending');
  });

  it('GET /api/orchestrator/tasks returns only kind=orchestrator tasks', async () => {
    // Create one todo and one orchestrator task
    await makeTodoRequest('POST', '/api/todos', { title: 'Todo task' });
    await makeOrchRequest('POST', '/api/orchestrator/tasks', { title: 'Orch task' });

    const res = await makeOrchRequest('GET', '/api/orchestrator/tasks');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data), 'data should be array');
    assert.equal(body.data.length, 1, 'should only return 1 orch task, not the todo');
    assert.equal(body.data[0].title, 'Orch task');
  });

  it('response shape includes UUID id and assignee field', async () => {
    const createRes = await makeOrchRequest('POST', '/api/orchestrator/tasks', {
      title: 'Shape check',
    });
    const created = JSON.parse(createRes.body);

    const getRes = await makeOrchRequest('GET', `/api/orchestrator/tasks/${created.id}`);
    assert.equal(getRes.status, 200);
    const body = JSON.parse(getRes.body);

    assert.ok(/^[0-9a-f-]{36}$/.test(body.id), 'id should be UUID');
    assert.ok('assignee' in body, 'should have assignee field (back-compat)');
  });

  it('response includes priority as integer (0/1/2) for back-compat', async () => {
    const createRes = await makeOrchRequest('POST', '/api/orchestrator/tasks', {
      title: 'Priority check',
      priority: 1,  // legacy integer format
    });
    assert.equal(createRes.status, 201);

    const created = JSON.parse(createRes.body);
    assert.ok(typeof created.priority === 'number', 'priority should be integer in orch response');
  });

  it('todo does NOT appear in /api/orchestrator/tasks list', async () => {
    await makeTodoRequest('POST', '/api/todos', { title: 'Should not appear' });

    const res = await makeOrchRequest('GET', '/api/orchestrator/tasks');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 0, 'no orch tasks — the todo should not appear');
  });

  it('orchestrator task does NOT appear in /api/todos list', async () => {
    await makeOrchRequest('POST', '/api/orchestrator/tasks', { title: 'Should not appear' });

    const res = await makeTodoRequest('GET', '/api/todos');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 0, 'no todos — the orch task should not appear');
  });
});
