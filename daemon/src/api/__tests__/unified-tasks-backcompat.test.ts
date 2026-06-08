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
import { openDatabase, _resetDbForTesting, exec, getDatabase } from '../../core/db.js';
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

// ── Collision-bug regression tests ────────────────────────────
//
// These tests directly reproduce the bug that would have been caught at
// tasks.id is a shared auto-increment sequence across both kind='todo' and
// kind='orchestrator'.  A legacy todo :id (stored as external_id) may happen
// to equal the tasks.id of an orchestrator row.
//
// Native-first update: the shim now tries tasks.id before external_id.
// The collision test is updated to reflect the approved endgame semantics:
// /api/todos/N returns the todo at tasks.id=N when one exists (native wins),
// even if a different todo has external_id='N'.

describe('shim id-collision regression', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('GET /api/todos/:id falls back to external_id when native id is an orch task', async () => {
    // 1. Create an orchestrator task — it occupies tasks.id=1 (first auto-increment slot)
    const orchRes = await makeOrchRequest('POST', '/api/orchestrator/tasks', { title: 'Orch task at id=1' });
    assert.equal(orchRes.status, 201);
    const orchTask = JSON.parse(orchRes.body);
    const orchIntId: number = orchTask._int_id; // tasks.id of the orch row

    // 2. Directly insert a legacy-style todo with external_id = CAST(orchIntId AS TEXT).
    //    This simulates a migrated todo whose original todos.id equals the orch task's
    //    tasks.id — the exact collision scenario the shim must handle correctly.
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, priority, tags, created_at, updated_at)
       VALUES (?, 'todo', 'Legacy todo with same id as orch', 'pending', 'medium', '[]', datetime('now'), datetime('now'))`,
      String(orchIntId),
    );

    // Get the todo's native tasks.id (it's the second row, so >orchIntId)
    const db = getDatabase();
    const todoRow = db.prepare(
      "SELECT id FROM tasks WHERE kind = 'todo' ORDER BY id DESC LIMIT 1",
    ).get() as { id: number };
    const todoNativeId = todoRow.id;

    // 3. GET /api/todos/<orchIntId>:
    //    - Native-first: tasks.id=orchIntId AND kind='todo' → no (orch occupies that slot)
    //    - Legacy fallback: external_id='orchIntId' AND kind='todo' → finds the todo
    //    Response id = todo's native tasks.id (not orchIntId — native-first semantics)
    const res = await makeTodoRequest('GET', `/api/todos/${orchIntId}`);
    assert.equal(res.status, 200, 'should find the todo via legacy fallback');
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'todo', 'must return a todo-kind row, not the orchestrator task');
    assert.equal(body.title, 'Legacy todo with same id as orch');
    assert.equal(body.id, todoNativeId, 'response id is native tasks.id (not the legacy external_id)');
    assert.ok(body.id !== orchIntId, 'native id of todo differs from the orch tasks.id slot');
    assert.equal(body.external_id, null, 'external_id is masked in response');
  });

  it('GET /api/orchestrator/tasks/:uuid resolves by external_id, is kind-scoped', async () => {
    // 1. Create a todo first — occupies tasks.id=1
    await makeTodoRequest('POST', '/api/todos', { title: 'Todo in slot 1' });

    // 2. Create an orch task — gets tasks.id=2, external_id=uuid
    const orchRes = await makeOrchRequest('POST', '/api/orchestrator/tasks', { title: 'Orch after todo' });
    assert.equal(orchRes.status, 201);
    const orchTask = JSON.parse(orchRes.body);
    const orchUuid: string = orchTask.id;
    const orchIntId: number = orchTask._int_id;

    // Sanity: orch task's tasks.id should be > 1 (todo occupied id=1)
    assert.ok(orchIntId > 1, 'orch task internal id should not be 1 (todo occupies slot 1)');

    // 3. GET by UUID must resolve via external_id (UUID contains dashes → not tasks.id)
    const res = await makeOrchRequest('GET', `/api/orchestrator/tasks/${orchUuid}`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, orchUuid, 'response id must be the UUID (external_id)');
    assert.equal(body._int_id, orchIntId, 'internal integer id is preserved separately');
    assert.equal(body.title, 'Orch after todo');

    // 4. GET /api/orchestrator/tasks/<orchIntId> (numeric) must NOT return the todo
    //    that happens to share tasks.id=1; it must check kind='orchestrator'.
    //    Since no orch task has tasks.id=1, this should 404.
    const numericRes = await makeOrchRequest('GET', '/api/orchestrator/tasks/1');
    assert.equal(numericRes.status, 404, 'numeric id=1 should 404 — that slot holds a todo, not an orch task');
  });

  it('POST /api/todos leaves external_id NULL (native-first: no stamping on new todos)', async () => {
    // Native-first: POST no longer stamps external_id = CAST(tasks.id AS TEXT).
    // The response id equals the native tasks.id directly.
    const res = await makeTodoRequest('POST', '/api/todos', { title: 'Round-trip check' });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    const nativeId: number = body.id;
    assert.ok(typeof nativeId === 'number', 'POST should return integer id');

    // DB must NOT have external_id set for a brand-new todo (native-first change)
    const db = getDatabase();
    const row = db.prepare(
      "SELECT id, external_id FROM tasks WHERE id = ? AND kind = 'todo'",
    ).get(nativeId) as { id: number; external_id: string | null } | undefined;

    assert.ok(row !== undefined, 'tasks row must exist after POST');
    assert.equal(row!.external_id, null, 'external_id must be NULL for new todos (no stamping)');
    assert.equal(row!.id, nativeId, 'tasks.id must equal the returned response id');
  });
});

// ── Native-first todo id lookup tests ─────────────────────────
//
// These tests verify the native-first resolveLegacyTodoId behavior:
// tasks.id lookup (kind='todo') takes precedence over external_id fallback.
// This fixes the case where todos with NULL external_id returned 404.

describe('native-first todo id lookup', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('GET /api/todos/:id resolves by native tasks.id when external_id IS NULL', async () => {
    // Simulate a todo with external_id IS NULL (e.g. created before migration stamping).
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (kind, title, status, priority, tags, created_at, updated_at)
       VALUES ('todo', 'Todo with null external_id', 'pending', 'medium', '[]', datetime('now'), datetime('now'))`,
    ).run();
    const row = db.prepare(
      "SELECT id FROM tasks WHERE kind = 'todo' ORDER BY id DESC LIMIT 1",
    ).get() as { id: number };
    const nativeId = row.id;

    const res = await makeTodoRequest('GET', `/api/todos/${nativeId}`);
    assert.equal(res.status, 200, 'native id with NULL external_id must return 200');
    const body = JSON.parse(res.body);
    assert.equal(body.id, nativeId, 'response id must be native tasks.id');
    assert.equal(body.title, 'Todo with null external_id');
    assert.equal(body.external_id, null, 'external_id is masked');
  });

  it('legacy external_id fallback resolves correctly when native tasks.id is absent', async () => {
    // Insert a todo with an explicit external_id that doesn't match its native id.
    // This simulates a pre-migration row where external_id != tasks.id.
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (external_id, kind, title, status, priority, tags, created_at, updated_at)
       VALUES ('9999', 'todo', 'Legacy external_id todo', 'pending', 'medium', '[]', datetime('now'), datetime('now'))`,
    ).run();
    const nativeRow = db.prepare(
      "SELECT id FROM tasks WHERE external_id = '9999' AND kind = 'todo'",
    ).get() as { id: number };
    const nativeId = nativeRow.id;

    // Lookup by the legacy display id (9999) — native lookup for tasks.id=9999 fails
    // (no todo there); fallback finds the row via external_id='9999'.
    const res = await makeTodoRequest('GET', '/api/todos/9999');
    assert.equal(res.status, 200, 'legacy fallback must resolve external_id=9999');
    const body = JSON.parse(res.body);
    assert.equal(body.id, nativeId, 'response id is the todo native tasks.id (not 9999)');
    assert.equal(body.title, 'Legacy external_id todo');
  });

  it('response id always equals native tasks.id (external_id no longer drives display id)', async () => {
    const res = await makeTodoRequest('POST', '/api/todos', { title: 'Native id display check' });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    const responseId: number = body.id;

    const db = getDatabase();
    const dbRow = db.prepare(
      "SELECT id FROM tasks WHERE id = ? AND kind = 'todo'",
    ).get(responseId) as { id: number } | undefined;
    assert.ok(dbRow !== undefined, 'task row must exist with native id');
    assert.equal(dbRow!.id, responseId, 'response id must equal native tasks.id');
  });

  it('collision: native-first returns todo at tasks.id=N even when another todo has external_id=N', async () => {
    // Set up: two todos
    //   todo A: native tasks.id=A, external_id pointing at idB (legacy mapping)
    //   todo B: native tasks.id=B, external_id=NULL  (new-style)
    // GET /api/todos/B → native-first: finds todo B (tasks.id=B, kind='todo') → returns B

    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (kind, title, status, priority, tags, created_at, updated_at)
       VALUES ('todo', 'Todo A', 'pending', 'medium', '[]', datetime('now'), datetime('now'))`,
    ).run();
    const rowA = db.prepare(
      "SELECT id FROM tasks WHERE title = 'Todo A' AND kind = 'todo'",
    ).get() as { id: number };
    const idA = rowA.id;

    db.prepare(
      `INSERT INTO tasks (kind, title, status, priority, tags, created_at, updated_at)
       VALUES ('todo', 'Todo B', 'pending', 'medium', '[]', datetime('now'), datetime('now'))`,
    ).run();
    const rowB = db.prepare(
      "SELECT id FROM tasks WHERE title = 'Todo B' AND kind = 'todo'",
    ).get() as { id: number };
    const idB = rowB.id;

    // Update todo A's external_id to point at idB (simulating a legacy collision)
    db.prepare('UPDATE tasks SET external_id = ? WHERE id = ?').run(String(idB), idA);

    // Native-first: GET /api/todos/<idB> → tasks.id=idB AND kind='todo' → todo B wins
    const res = await makeTodoRequest('GET', `/api/todos/${idB}`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.title, 'Todo B', 'native-first must return todo B, not todo A whose external_id points here');
    assert.equal(body.id, idB, 'response id is native tasks.id of the winning row');

    // Confirm todo A is reachable via its own native id
    const resA = await makeTodoRequest('GET', `/api/todos/${idA}`);
    assert.equal(resA.status, 200);
    const bodyA = JSON.parse(resA.body);
    assert.equal(bodyA.title, 'Todo A');
    assert.equal(bodyA.id, idA);
  });

  it('new todo creation leaves external_id NULL in the tasks table', async () => {
    const res = await makeTodoRequest('POST', '/api/todos', {
      title: 'Brand new todo',
      priority: 'low',
    });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);

    const db = getDatabase();
    const row = db.prepare(
      "SELECT external_id FROM tasks WHERE id = ? AND kind = 'todo'",
    ).get(body.id) as { external_id: string | null } | undefined;

    assert.ok(row !== undefined, 'row must exist');
    assert.equal(row!.external_id, null, 'new todos must NOT have external_id stamped');
  });
});

// ── /api/todos status alias normalization (#211) ───────────────

describe('/api/todos status alias normalization', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it("PUT /api/todos/:id with status 'done' stores as 'completed'", async () => {
    const createRes = await makeTodoRequest('POST', '/api/todos', { title: 'alias-done-todo' });
    assert.equal(createRes.status, 201);
    const todo = JSON.parse(createRes.body);

    const putRes = await makeTodoRequest('PUT', `/api/todos/${todo.id}`, { status: 'done' });
    assert.equal(putRes.status, 200, "'done' should be accepted");
    assert.equal(JSON.parse(putRes.body).status, 'completed', "response status must be 'completed'");

    // Confirm via GET
    const getRes = await makeTodoRequest('GET', `/api/todos/${todo.id}`);
    assert.equal(getRes.status, 200);
    assert.equal(JSON.parse(getRes.body).status, 'completed', "GET must return 'completed'");
  });

  it("PUT /api/todos/:id with status 'wip' stores as 'in_progress'", async () => {
    const createRes = await makeTodoRequest('POST', '/api/todos', { title: 'alias-wip-todo' });
    const todo = JSON.parse(createRes.body);

    const putRes = await makeTodoRequest('PUT', `/api/todos/${todo.id}`, { status: 'wip' });
    assert.equal(putRes.status, 200, "'wip' should be accepted");
    assert.equal(JSON.parse(putRes.body).status, 'in_progress');

    const getRes = await makeTodoRequest('GET', `/api/todos/${todo.id}`);
    assert.equal(JSON.parse(getRes.body).status, 'in_progress');
  });

  it("alias lookup is case-insensitive: 'Wip' → 'in_progress'", async () => {
    const createRes = await makeTodoRequest('POST', '/api/todos', { title: 'alias-case-wip' });
    const todo = JSON.parse(createRes.body);

    const putRes = await makeTodoRequest('PUT', `/api/todos/${todo.id}`, { status: 'Wip' });
    assert.equal(putRes.status, 200, "'Wip' should be accepted");
    assert.equal(JSON.parse(putRes.body).status, 'in_progress');
  });

  it("unknown status still returns HTTP 400 via /api/todos", async () => {
    const createRes = await makeTodoRequest('POST', '/api/todos', { title: 'alias-bogus-todo' });
    const todo = JSON.parse(createRes.body);

    const putRes = await makeTodoRequest('PUT', `/api/todos/${todo.id}`, { status: 'bogus' });
    assert.equal(putRes.status, 400, "unrecognised value must still be rejected");
  });
});
