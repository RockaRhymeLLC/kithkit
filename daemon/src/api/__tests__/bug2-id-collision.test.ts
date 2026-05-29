/**
 * BUG 2 — id-collision / shim-parity regression tests.
 *
 * Covers:
 *   1. Warning-path: log.warn fires when PUT /api/tasks/:id resolves to a kind='todo' row.
 *   2. Shim round-trip A: PUT /api/todos/:id with assigned_to persists, GET returns it.
 *   3. Shim round-trip B: PUT /api/todos/:id with work_notes persists, GET returns it.
 *   4. Graceful-degrade: PUT /api/todos/:id returns 503 (not 500/crash) when schema flag is false.
 *
 * Reference: kithkit-internal #1812 (cross-agent coordination tracker).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openDatabase,
  _resetDbForTesting,
  _setShimPragmaOkForTesting,
  exec,
} from '../../core/db.js';
import { _resetLoggerForTesting } from '../../core/logger.js';
import { handleUnifiedTasksRoute } from '../unified-tasks.js';
import { handleStateRoute } from '../state.js';

// ── Port allocation (unique to avoid conflicts with other test files) ──────────
const TASKS_PORT = 19893;  // /api/tasks handler (unified-tasks)
const TODOS_PORT = 19894;  // /api/todos handler (state)

// ── Request helpers ────────────────────────────────────────────────────────────

function requestTasks(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: string }> {
  return makeRequest(TASKS_PORT, method, urlPath, body);
}

function requestTodos(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: string }> {
  return makeRequest(TODOS_PORT, method, urlPath, body);
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

let tasksServer: http.Server;
let todosServer: http.Server;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-bug2-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Initialize logger to write to tmpDir so warn messages can be verified.
  _resetLoggerForTesting({ logDir: tmpDir, minLevel: 'warn' });

  tasksServer = makeHandler(handleUnifiedTasksRoute, TASKS_PORT);
  todosServer = makeHandler(handleStateRoute, TODOS_PORT);

  return new Promise<void>((resolve) => {
    tasksServer.listen(TASKS_PORT, '127.0.0.1', () => {
      todosServer.listen(TODOS_PORT, '127.0.0.1', resolve);
    });
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _resetDbForTesting(); // also resets _shimPragmaOk
    todosServer.close(() => {
      tasksServer.close(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    });
  });
}

// ── Helper: read daemon.log content ───────────────────────────────────────────

function readLog(): string {
  const logFile = path.join(tmpDir, 'daemon.log');
  if (!fs.existsSync(logFile)) return '';
  return fs.readFileSync(logFile, 'utf8');
}

// ── Test 1: Warning-path ───────────────────────────────────────────────────────
//
// Verifies that PUT /api/tasks/:id emits a log.warn when the integer path param
// resolves to a kind='todo' row.  The response must still be 200 (no behavior
// change — only the warning is added).

describe('BUG2: PUT /api/tasks/:id warns on todo-row collision', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('emits log.warn and returns 200 when integer id resolves to a kind=todo row', async () => {
    // Create a todo via the canonical tasks endpoint.
    // This creates a tasks row with kind='todo' and tasks.id=N.
    const createRes = await requestTasks('POST', '/api/tasks', { title: 'Collision-prone todo', kind: 'todo' });
    assert.equal(createRes.status, 201);
    const created = JSON.parse(createRes.body);
    const internalId: number = created.id; // tasks.id (auto-increment PK)
    assert.equal(created.kind, 'todo');

    // PUT /api/tasks/<internalId> → integer lookup → resolves to kind='todo' row → warn fires.
    const putRes = await requestTasks('PUT', `/api/tasks/${internalId}`, {
      title: 'Updated via canonical endpoint',
    });
    // Behavior must be preserved — the update succeeds.
    assert.equal(putRes.status, 200, 'PUT should succeed (behavior unchanged); only a warn is emitted');
    const putBody = JSON.parse(putRes.body);
    assert.equal(putBody.title, 'Updated via canonical endpoint');
    assert.equal(putBody.kind, 'todo');

    // Verify the warn was written to the log file.
    // Log lines are JSON-serialized, so literal " chars become \" in the file.
    // We check for unique substrings that survive JSON encoding unchanged.
    const logContent = readLog();
    assert.ok(
      logContent.includes('kithkit-internal #1812') && logContent.includes('internal PK'),
      `Expected log.warn about todo-row collision. Log contents:\n${logContent}`,
    );
  });
});

// ── Test 2 & 3: Shim round-trips ──────────────────────────────────────────────

describe('BUG2: PUT /api/todos/:id shim round-trips for assigned_to and work_notes', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('PUT /api/todos/:id with assigned_to — GET returns the persisted value', async () => {
    // Create a todo via the shim.
    const createRes = await requestTodos('POST', '/api/todos', { title: 'Assignable todo' });
    assert.equal(createRes.status, 201);
    const todo = JSON.parse(createRes.body);
    const todoId: number = todo.id;

    // PUT with assigned_to.
    const putRes = await requestTodos('PUT', `/api/todos/${todoId}`, {
      assigned_to: 'orchestrator',
    });
    assert.equal(putRes.status, 200, 'PUT with assigned_to should succeed');
    const putBody = JSON.parse(putRes.body);
    assert.equal(putBody.assigned_to, 'orchestrator', 'PUT response should reflect assigned_to');

    // GET must return the persisted value.
    const getRes = await requestTodos('GET', `/api/todos/${todoId}`);
    assert.equal(getRes.status, 200);
    const getBody = JSON.parse(getRes.body);
    assert.equal(getBody.assigned_to, 'orchestrator', 'GET should return the persisted assigned_to');
  });

  it('PUT /api/todos/:id with work_notes — GET returns the persisted value', async () => {
    // Create a todo via the shim.
    const createRes = await requestTodos('POST', '/api/todos', { title: 'Work-noted todo' });
    assert.equal(createRes.status, 201);
    const todo = JSON.parse(createRes.body);
    const todoId: number = todo.id;

    // PUT with work_notes.
    const noteText = 'Blocked on upstream API; retrying at 09:00.';
    const putRes = await requestTodos('PUT', `/api/todos/${todoId}`, {
      work_notes: noteText,
    });
    assert.equal(putRes.status, 200, 'PUT with work_notes should succeed');
    const putBody = JSON.parse(putRes.body);
    assert.equal(putBody.work_notes, noteText, 'PUT response should reflect work_notes');

    // GET must return the persisted value.
    const getRes = await requestTodos('GET', `/api/todos/${todoId}`);
    assert.equal(getRes.status, 200);
    const getBody = JSON.parse(getRes.body);
    assert.equal(getBody.work_notes, noteText, 'GET should return the persisted work_notes');
  });

  it('PUT /api/todos/:id with unknown field emits log.warn but still returns 200', async () => {
    const createRes = await requestTodos('POST', '/api/todos', { title: 'Warn-on-unknown todo' });
    assert.equal(createRes.status, 201);
    const todo = JSON.parse(createRes.body);
    const todoId: number = todo.id;

    // PUT with an unknown field (not in the whitelist).
    const putRes = await requestTodos('PUT', `/api/todos/${todoId}`, {
      title: 'Updated',
      unknown_bogus_field: 'should be warned about',
    });
    // Must succeed (backward compat — unknown fields are dropped, not rejected).
    assert.equal(putRes.status, 200, 'unknown fields are dropped, not rejected');

    // Warn must appear in the log.
    const logContent = readLog();
    assert.ok(
      logContent.includes('unknown_bogus_field') && logContent.includes('kithkit-internal #1812'),
      `Expected log.warn for dropped field. Log contents:\n${logContent}`,
    );
  });
});

// ── Test 4: Graceful degrade ───────────────────────────────────────────────────

describe('BUG2: PUT /api/todos/:id returns 503 when schema flag is false', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns 503 (not 500/crash) when _shimPragmaOk is false', async () => {
    // Create a todo so the route can even be reached.
    const createRes = await requestTodos('POST', '/api/todos', { title: 'Degrade test todo' });
    assert.equal(createRes.status, 201);
    const todo = JSON.parse(createRes.body);
    const todoId: number = todo.id;

    // Simulate an older daemon with missing migration columns.
    _setShimPragmaOkForTesting(false);

    const putRes = await requestTodos('PUT', `/api/todos/${todoId}`, {
      title: 'Should not be applied',
    });

    assert.equal(putRes.status, 503, 'Expected 503 Service Unavailable when schema is incomplete');
    const putBody = JSON.parse(putRes.body);
    assert.ok(typeof putBody.error === 'string' && putBody.error.length > 0, 'Response must include an error message');
    assert.ok(putBody.error.includes('migration'), 'Error message should reference migrations');

    // Confirm the update was NOT applied (GET still returns original title).
    const getRes = await requestTodos('GET', `/api/todos/${todoId}`);
    assert.equal(getRes.status, 200);
    const getBody = JSON.parse(getRes.body);
    assert.equal(getBody.title, 'Degrade test todo', 'Title must not have changed when 503 was returned');
  });
});
