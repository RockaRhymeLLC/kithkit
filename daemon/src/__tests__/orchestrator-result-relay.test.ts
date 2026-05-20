/**
 * Regression tests for orchestrator result auto-relay to requesting peer.
 *
 * When a task has requesting_peer set, auto-completing the task via a result
 * message should fire an A2A DM back to that peer (fire-and-forget).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query, exec } from '../core/db.js';
import { handleMessagesRoute } from '../api/messages.js';
import { handleOrchestratorRoute } from '../api/orchestrator.js';
import {
  _setTmuxInjectorForTesting,
  _clearDedupForTesting,
  _setA2ARouterForTesting,
} from '../agents/message-router.js';

const TEST_PORT = 19884;

// ── Helpers ──────────────────────────────────────────────────

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

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-relay-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Silence tmux injection in all tests
  _setTmuxInjectorForTesting(() => false);

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    void (async () => {
      try {
        if (await handleMessagesRoute(inReq, res, url.pathname, url.searchParams)) return;
        if (await handleOrchestratorRoute(inReq, res, url.pathname)) return;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
    })();
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    _clearDedupForTesting();
    _setTmuxInjectorForTesting(null);
    _setA2ARouterForTesting(null);
    server.close(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

function seedTask(id: string, status: string, requestingPeer: string | null): void {
  const ts = '2026-01-01T00:00:00Z';
  exec(
    `INSERT INTO orchestrator_tasks (id, title, status, priority, requesting_peer, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
    id, `Task ${id}`, status, requestingPeer, ts, ts,
  );
}

function addWorker(taskId: string, workerId: string): void {
  exec(
    `INSERT INTO orchestrator_task_workers (task_id, worker_id, role, assigned_at)
     VALUES (?, ?, NULL, '2026-01-01T00:00:00Z')`,
    taskId, workerId,
  );
}

// ── Tests ────────────────────────────────────────────────────

describe('orchestrator result auto-relay to requesting_peer', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('happy path: result message with requesting_peer → task completed + peer DM sent', async () => {
    seedTask('task-relay', 'in_progress', 'bmo');
    addWorker('task-relay', 'worker-1');

    const captured: unknown[] = [];
    _setA2ARouterForTesting({
      send: async (body) => { captured.push(body); return { ok: true }; },
    });

    const res = await request('POST', '/api/messages', {
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'All done!',
      metadata: { task_id: 'task-relay', completion: true },
    });

    assert.equal(res.status, 200);

    // Let fire-and-forget settle
    await new Promise(r => setImmediate(r));

    const task = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-relay');
    assert.equal(task[0]!.status, 'completed', 'task should be auto-completed');

    assert.equal(captured.length, 1, 'stub should have been called once');
    const sent = captured[0] as { to: string; type: string; text: string };
    assert.equal(sent.to, 'bmo');
    assert.equal(sent.type, 'text');
    assert.equal(sent.text, 'All done!');
  });

  it('null requesting_peer → task completed, stub NOT called', async () => {
    seedTask('task-no-peer', 'in_progress', null);
    addWorker('task-no-peer', 'worker-2');

    const captured: unknown[] = [];
    _setA2ARouterForTesting({
      send: async (body) => { captured.push(body); return { ok: true }; },
    });

    const res = await request('POST', '/api/messages', {
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Done with no peer',
      metadata: { task_id: 'task-no-peer', completion: true },
    });

    assert.equal(res.status, 200);

    await new Promise(r => setImmediate(r));

    const task = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-no-peer');
    assert.equal(task[0]!.status, 'completed', 'task should be completed');
    assert.equal(captured.length, 0, 'stub must NOT be called when requesting_peer is null');
  });

  it('stub router throws inside send() → task still completed, POST returns 2xx', async () => {
    seedTask('task-throw', 'in_progress', 'bmo');
    addWorker('task-throw', 'worker-3');

    _setA2ARouterForTesting({
      send: async () => { throw new Error('network failure'); },
    });

    const res = await request('POST', '/api/messages', {
      from: 'orchestrator',
      to: 'comms',
      type: 'result',
      body: 'Result despite relay failure',
      metadata: { task_id: 'task-throw', completion: true },
    });

    // Must not return 500 — relay failure is non-fatal
    assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);

    await new Promise(r => setImmediate(r));

    const task = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-throw');
    assert.equal(task[0]!.status, 'completed', 'task must be completed even when relay throws');
  });

  it('POST /api/orchestrator/escalate with requesting_peer=bmo → row stored with requesting_peer=bmo', async () => {
    const res = await request('POST', '/api/orchestrator/escalate', {
      task: 'Do some research for BMO',
      requesting_peer: 'bmo',
    });

    // 200 or 202 — orchestrator not running in test environment is fine
    assert.ok(res.status === 200 || res.status === 202 || res.status === 500,
      `unexpected status ${res.status}`);

    // Find the task row regardless of escalate response
    const tasks = query<{ requesting_peer: string | null; title: string }>(
      `SELECT requesting_peer, title FROM orchestrator_tasks WHERE title LIKE '%BMO%'`,
    );
    assert.ok(tasks.length > 0, 'task row should have been created');
    assert.equal(tasks[0]!.requesting_peer, 'bmo', 'requesting_peer should be stored as bmo');
  });

  it('POST /api/orchestrator/escalate with invalid requesting_peer → stored as null', async () => {
    const res = await request('POST', '/api/orchestrator/escalate', {
      task: 'Do some work with invalid peer',
      requesting_peer: 'BMO!!',
    });

    assert.ok(res.status === 200 || res.status === 202 || res.status === 500,
      `unexpected status ${res.status}`);

    const tasks = query<{ requesting_peer: string | null; title: string }>(
      `SELECT requesting_peer, title FROM orchestrator_tasks WHERE title LIKE '%invalid peer%'`,
    );
    assert.ok(tasks.length > 0, 'task row should have been created');
    assert.equal(tasks[0]!.requesting_peer, null, 'invalid requesting_peer should be stored as null');
  });

  it('requesting_peer set + getA2ARouter() returns null → "A2A router not initialised" warn fires, task still completes', async () => {
    seedTask('task-null-router', 'in_progress', 'bmo');
    addWorker('task-null-router', 'worker-6');

    // _testRouter is null (cleared by teardown); getA2ARouter() also returns null
    // in the test environment — no A2A handler is initialised. The code should
    // log a warn and continue without throwing.
    const warnLines: string[] = [];
    const origConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      warnLines.push(args.join(' '));
      origConsoleLog(...args);
    };

    try {
      const res = await request('POST', '/api/messages', {
        from: 'orchestrator',
        to: 'comms',
        type: 'result',
        body: 'Result with null router',
        metadata: { task_id: 'task-null-router', completion: true },
      });

      assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);

      await new Promise(r => setImmediate(r));

      // Assert: the 'A2A router not initialised' warn was logged
      const routerWarn = warnLines.find(l => l.includes('A2A router not initialised'));
      assert.ok(routerWarn !== undefined, 'expected "A2A router not initialised" warn to fire');

      // Assert: task still auto-completes despite null router
      const task = query<{ status: string }>('SELECT status FROM orchestrator_tasks WHERE id = ?', 'task-null-router');
      assert.equal(task[0]!.status, 'completed', 'task should be completed even when A2A router is null');
    } finally {
      console.log = origConsoleLog;
    }
  });
});
