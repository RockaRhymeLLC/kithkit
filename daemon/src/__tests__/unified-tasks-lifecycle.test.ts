/**
 * Regression tests for #470: failed-terminal + escape-valve transitions via
 * the canonical PUT /api/tasks/:id route (unified-tasks.ts).
 *
 * Mutation-killing contract: reverting the escape-valve transition or
 * the failed-terminal reconciliation causes these tests to go RED.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec, query } from '../core/db.js';
import { handleUnifiedTasksRoute, _setTmuxInjectorForTesting, _setEvaluateTaskFnForTesting } from '../api/unified-tasks.js';

const TEST_PORT_UNIFIED = 19879;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT_UNIFIED,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
        ...(headers ?? {}),
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-unified-470-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Suppress tmux injection and retro eval in tests
  _setTmuxInjectorForTesting(() => false);
  _setEvaluateTaskFnForTesting(async () => { /* noop */ });

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT_UNIFIED}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleUnifiedTasksRoute(inReq, res, url.pathname, url.searchParams)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
  });

  return new Promise<void>((resolve) => server.listen(TEST_PORT_UNIFIED, '127.0.0.1', resolve));
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _setTmuxInjectorForTesting(null);
    _setEvaluateTaskFnForTesting(null);
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

/**
 * Seed a task directly in the DB at a given status, bypassing the state machine.
 * This lets us start at 'failed' without needing to chain all prior transitions.
 * Returns the external_id (UUID string).
 */
function seedOrchestratorTask(extId: string, status: string): void {
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Escape-valve test', 'test desc', ?, 'medium', 'orchestrator', ?, ?)`,
    extId, status, ts, ts,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#470 escape-valve via PUT /api/tasks/:id (unified-tasks)', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('failed → completed returns 200 (#470 escape-valve on canonical endpoint)', async () => {
    // MUTATION-KILL: revert failed→completed escape-valve in VALID_TRANSITIONS or
    // revert the isFailedEscapeValve guard → this returns 409/422
    const extId = 'aabbccdd-0001-0002-0003-00000000ab01';
    seedOrchestratorTask(extId, 'failed');

    const res = await request('PUT', `/api/tasks/${extId}`, {
      status: 'completed',
      result: 'worker succeeded; orch restarted before synthesis',
    });
    assert.equal(res.status, 200, `Expected 200 for failed→completed, got ${res.status}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'completed');
  });

  it('failed → cancelled returns 200 (#470 escape-valve on canonical endpoint)', async () => {
    // MUTATION-KILL: revert failed→cancelled escape-valve → this returns 422
    const extId = 'aabbccdd-0001-0002-0003-00000000ab02';
    seedOrchestratorTask(extId, 'failed');

    const res = await request('PUT', `/api/tasks/${extId}`, { status: 'cancelled' });
    assert.equal(res.status, 200, `Expected 200 for failed→cancelled, got ${res.status}: ${res.body}`);
    assert.equal(JSON.parse(res.body).status, 'cancelled');
  });

  it('acknowledged_at is writable on a failed task via canonical endpoint (#470)', async () => {
    // MUTATION-KILL: revert failed-terminal (remove 'failed' from TERMINAL_STATUSES) →
    // this returns 409 "acknowledged_at can only be set on terminal tasks"
    const extId = 'aabbccdd-0001-0002-0003-00000000ab03';
    seedOrchestratorTask(extId, 'failed');

    const ackTime = new Date().toISOString();
    const res = await request('PUT', `/api/tasks/${extId}`, {
      acknowledged_at: ackTime,
      comms_outcome: 'accepted',
    }, { 'x-agent': 'comms' });
    assert.equal(res.status, 200, `Expected 200 setting acknowledged_at on failed task, got ${res.status}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(body.acknowledged_at, 'acknowledged_at should be set after the fix');
  });

  it('failed → completed + acknowledged_at in one PUT (#470 — full closure path)', async () => {
    // MUTATION-KILL: revert either escape-valve or failed-terminal → this fails
    const extId = 'aabbccdd-0001-0002-0003-00000000ab04';
    seedOrchestratorTask(extId, 'failed');

    const ackTime = new Date().toISOString();
    const res = await request('PUT', `/api/tasks/${extId}`, {
      status: 'completed',
      result: 'done',
      acknowledged_at: ackTime,
      comms_outcome: 'accepted',
    }, { 'x-agent': 'comms' });
    assert.equal(res.status, 200, `Expected 200 for combined transition+ack, got ${res.status}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'completed');
    assert.ok(body.acknowledged_at, 'acknowledged_at should be set');
  });

  it('completed tasks remain blocked from non-feedback status updates', async () => {
    // Confirm the terminal guard is still enforced for completed (not regressed)
    const extId = 'aabbccdd-0001-0002-0003-00000000ab05';
    seedOrchestratorTask(extId, 'completed');

    const res = await request('PUT', `/api/tasks/${extId}`, { status: 'pending' });
    assert.equal(res.status, 409, `completed → pending must remain blocked, got ${res.status}: ${res.body}`);
  });

  it('todo tasks: isFailedEscapeValve guard excludes kind=todo (no escape-valve for todos)', async () => {
    // #470 behavior contract: the `task.kind !== 'todo'` guard in isFailedEscapeValve means
    // todo tasks in 'failed' status do NOT get the escape-valve treatment.
    // Since 'failed' is now terminal (per #470), a failed todo task is blocked from
    // non-feedback updates via /api/tasks/:id.
    //
    // This is intentional by design:
    //   - Todo tasks should be updated via /api/todos/:id (the shim), not the canonical endpoint.
    //   - The /api/tasks/:id endpoint warns (line 927-937) when an integer path resolves to a todo.
    //   - The isFailedEscapeValve is only for orchestrator tasks (kind='orchestrator').
    //
    // MUTATION-KILL: this test also confirms the 'failed' terminal guard is active for todos —
    // if 'failed' were removed from TERMINAL_STATUSES, the todo update would succeed (200) → RED.
    const ts = new Date().toISOString();
    exec(
      `INSERT INTO tasks (kind, title, status, priority, source, created_at, updated_at)
       VALUES ('todo', 'A todo task', 'failed', 'medium', null, ?, ?)`,
      ts, ts,
    );
    const rows = query<{ id: number }>(`SELECT id FROM tasks WHERE kind='todo' AND title='A todo task'`);
    const intId = rows[0]?.id;
    assert.ok(intId, 'todo task should exist');

    // Failed todo tasks are blocked by the terminal guard (escape-valve does not apply to todos).
    // The correct path for todo updates is /api/todos/:id, not /api/tasks/:id.
    const res = await request('PUT', `/api/tasks/${intId}`, { status: 'completed' });
    assert.equal(
      res.status, 409,
      `Failed todo via /api/tasks/:id must be blocked (409) — escape-valve is orchestrator-only. ` +
      `Got ${res.status}: ${res.body}`,
    );
  });
});
