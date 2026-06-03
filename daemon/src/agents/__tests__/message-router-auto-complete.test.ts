/**
 * Tests for the message-router auto-complete guard (#302).
 *
 * The orchestrator-result auto-complete hook at message-router.ts:118-199
 * was firing on any {from:'orchestrator', type:'result'} message whose
 * metadata.task_id matched an active task.  The orchestrator-idle shutdown
 * prompt tells the orchestrator to send a type:'result' ack; if that message
 * included the active task_id, the task was wrongly locked in 'completed'.
 *
 * Fix: require explicit metadata.completion === true (boolean) or 'true'
 * (string) before writing status='completed'.  All other values suppress
 * the write (fail-safe) while still delivering the message to comms.
 *
 * 8 tests covering:
 *   1. Happy path — completion:true (boolean)
 *   2. String form — completion:'true'
 *   3. REGRESSION #302 — missing completion flag
 *   4. Negation — completion:false
 *   5. Other truthy-ish values rejected (1, 'yes')
 *   6. type:'status' gate — completion:true on a status-type message
 *   7. Ghost-protection (#266) still works with completion:true
 *   8. Recovery path — PUT status:'failed' succeeds after suppressed auto-complete
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  openDatabase,
  _resetDbForTesting,
  query,
  exec,
} from '../../core/db.js';
import {
  sendMessage,
  _setTmuxInjectorForTesting,
  _clearDedupForTesting,
  _setA2ARouterForTesting,
} from '../message-router.js';
import { handleTaskQueueRoute } from '../../api/task-queue.js';

const TEST_PORT = 19895;

// ── HTTP helper ───────────────────────────────────────────────

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

// ── Setup / teardown ─────────────────────────────────────────

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-mr-ac-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Suppress tmux injection — no real session in tests
  _setTmuxInjectorForTesting(() => false);
  // Suppress A2A relay
  _setA2ARouterForTesting(null);

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleTaskQueueRoute(inReq, res, url.pathname, url.searchParams)
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

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  _clearDedupForTesting();
  _setTmuxInjectorForTesting(null);
  _setA2ARouterForTesting(null);
  _resetDbForTesting();
  return new Promise<void>((resolve) => {
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

// ── Test helpers ─────────────────────────────────────────────

/** Insert a task directly into orchestrator_tasks with the given status. */
function createLegacyTask(id: string, status = 'in_progress'): void {
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO orchestrator_tasks (id, title, description, status, created_at, updated_at)
     VALUES (?, 'Test task', 'Do the thing', ?, ?, ?)`,
    id, status, ts, ts,
  );
}

/**
 * Insert a corresponding task into the unified tasks table.
 * Used for test 8 where task-queue.ts PUT reads from tasks (not orchestrator_tasks).
 */
function createUnifiedTask(externalId: string, status = 'in_progress'): void {
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, created_at, updated_at)
     VALUES (?, 'orchestrator', 'Test task', 'Do the thing', ?, 'medium', 'orchestrator', ?, ?)`,
    externalId, status, ts, ts,
  );
}

/** Add a worker row to orchestrator_task_workers (satisfies ghost-protection #266). */
function addLegacyWorker(taskId: string): void {
  exec(
    `INSERT INTO orchestrator_task_workers (task_id, worker_id, role, assigned_at)
     VALUES (?, 'worker-test-01', 'coding', ?)`,
    taskId, new Date().toISOString(),
  );
}

/** Get task status from orchestrator_tasks. */
function getLegacyStatus(taskId: string): string | null {
  const rows = query<{ status: string }>(`SELECT status FROM orchestrator_tasks WHERE id = ?`, taskId);
  return rows[0]?.status ?? null;
}

/**
 * Send an orchestrator result message with optional extra metadata.
 * Clears dedup cache first so sequential calls in the same test don't collide.
 */
function sendResult(taskId: string, meta: Record<string, unknown> = {}): ReturnType<typeof sendMessage> {
  _clearDedupForTesting();
  return sendMessage({
    from: 'orchestrator',
    to: 'comms',
    type: 'result',
    body: 'Task done',
    metadata: { task_id: taskId, ...meta },
  });
}

// ── Tests ────────────────────────────────────────────────────

describe('message-router auto-complete (#302)', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  // 1. Happy path — completion:true (boolean)
  it('auto-completes task when metadata.completion === true (boolean)', () => {
    const id = randomUUID();
    createLegacyTask(id);
    addLegacyWorker(id);

    const result = sendResult(id, { completion: true });

    assert.ok(result.messageId > 0, 'message must be stored');
    assert.equal(getLegacyStatus(id), 'completed', 'task must be auto-completed');
  });

  // 2. String form — completion:'true'
  it("auto-completes task when metadata.completion === 'true' (string)", () => {
    const id = randomUUID();
    createLegacyTask(id);
    addLegacyWorker(id);

    const result = sendResult(id, { completion: 'true' });

    assert.ok(result.messageId > 0, 'message must be stored');
    assert.equal(getLegacyStatus(id), 'completed', "string 'true' must also trigger auto-complete");
  });

  // 3. REGRESSION #302 — missing completion flag
  it('does NOT auto-complete when metadata.completion is absent (#302 regression)', () => {
    const id = randomUUID();
    createLegacyTask(id);
    addLegacyWorker(id);

    // No completion flag — the bug: this used to wrongly complete the task
    const result = sendResult(id);

    assert.ok(result.messageId > 0, 'message must still be stored and delivered');
    assert.equal(
      getLegacyStatus(id),
      'in_progress',
      'task must remain in_progress — auto-complete must be suppressed when completion flag is absent',
    );
  });

  // 4. Negation — completion:false
  it('does NOT auto-complete when metadata.completion === false', () => {
    const id = randomUUID();
    createLegacyTask(id);
    addLegacyWorker(id);

    const result = sendResult(id, { completion: false });

    assert.ok(result.messageId > 0, 'message must be stored');
    assert.equal(getLegacyStatus(id), 'in_progress', 'completion:false must not trigger auto-complete');
  });

  // 5. Other truthy-ish values rejected (explicit contract: only true/true are accepted)
  it('does NOT auto-complete for other truthy-ish values (number 1 or string "yes")', () => {
    const idNum = randomUUID();
    createLegacyTask(idNum);
    addLegacyWorker(idNum);
    sendResult(idNum, { completion: 1 });
    assert.equal(getLegacyStatus(idNum), 'in_progress', 'completion:1 (number) must not trigger auto-complete');

    const idStr = randomUUID();
    createLegacyTask(idStr);
    addLegacyWorker(idStr);
    sendResult(idStr, { completion: 'yes' });
    assert.equal(getLegacyStatus(idStr), 'in_progress', 'completion:"yes" must not trigger auto-complete');
  });

  // 6. type:'status' gate — the type==='result' guard at line 121 still gates the path
  it("does NOT auto-complete when type is 'status' even with completion:true", () => {
    const id = randomUUID();
    createLegacyTask(id);
    addLegacyWorker(id);

    _clearDedupForTesting();
    const result = sendMessage({
      from: 'orchestrator',
      to: 'comms',
      type: 'status',
      body: 'Graceful shutdown ack',
      metadata: { task_id: id, completion: true },
    });

    assert.ok(result.messageId > 0, 'message must be stored');
    assert.equal(
      getLegacyStatus(id),
      'in_progress',
      "type:'status' must not trigger auto-complete regardless of completion flag",
    );
  });

  // 7. Ghost-protection (#266) still works — completion:true but zero work evidence
  it('rejects auto-complete via ghost-protection when task has no workers and no activity (#266)', () => {
    const id = randomUUID();
    // Deliberately NO worker rows and NO activity rows
    createLegacyTask(id);

    const result = sendResult(id, { completion: true });

    assert.ok(result.messageId > 0, 'message must be stored');
    assert.equal(
      getLegacyStatus(id),
      'in_progress',
      'ghost-protection (#266) must block auto-complete even with completion:true when zero work evidence exists',
    );
  });

  // 8. Recovery path — PUT status:'failed' succeeds after suppressed auto-complete
  it('allows PUT status:failed after auto-complete was correctly suppressed (#302 regression)', async () => {
    const id = randomUUID();
    // Mirror production state: task exists in BOTH tables after migration 024
    createLegacyTask(id, 'in_progress');
    createUnifiedTask(id, 'in_progress');
    addLegacyWorker(id);

    // Send without completion flag — auto-complete must be suppressed
    sendResult(id);
    assert.equal(getLegacyStatus(id), 'in_progress', 'pre-condition: task must not be auto-completed');

    // Recovery PUT must succeed — the task is NOT in a terminal state
    const putRes = await request('PUT', `/api/orchestrator/tasks/${id}`, {
      status: 'failed',
      result: 'Worker errored out',
    });

    assert.equal(
      putRes.status,
      200,
      `Expected HTTP 200 (not locked) but got ${putRes.status}. Body: ${putRes.body}`,
    );
    const body = JSON.parse(putRes.body);
    assert.equal(body.status, 'failed', 'task should now be failed');
  });
});
