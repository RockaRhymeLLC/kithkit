/**
 * Regression test: GATE 2 of the wedge detector must null assigned_to.
 *
 * Bug: GATE 2 (restartWedgedOrchestrator in context-watchdog.ts) regresses a frozen
 * in_progress orchestrator task to 'pending' via a raw SQL UPDATE that bypasses the
 * task-queue API's drift rule (task-queue.ts validateStatusAssignee: pending tasks
 * must have a null assignee). If the frozen task had a non-null assigned_to, the raw
 * UPDATE left it status='pending' WITH an assignee — an invalid combination per the
 * API's own invariant. The next API PUT to that row then 400s, making the task
 * unwritable wreckage.
 *
 * Fix: GATE 2's UPDATE now also sets assigned_to = NULL, matching the drift rule
 * already enforced by the two sibling pending-reset paths in unified-tasks.ts (retry,
 * status-transition) and task-queue.ts (retry, status-transition drift rule).
 *
 * This test drives the REAL wedge-restart path (via _runForTesting), triggering via
 * signal(iii) (garbled/feedback-prompt pane) — the one wedge signal that bypasses the
 * multi-tick debounce gate (WEDGE_DEBOUNCE_THRESHOLD), so a single _runForTesting()
 * call deterministically produces a real restart. GATE 2 itself re-selects frozen tasks
 * independently by `updated_at < cutoffIso` (see restartWedgedOrchestrator in
 * context-watchdog.ts), so it regresses the seeded stale task regardless of which signal
 * triggered the restart — this test does not depend on signal(i)'s own
 * exemption/debounce bookkeeping.
 * It then drives a REAL HTTP PUT through handleTaskQueueRoute (no route mocking) to
 * prove the row is left in a state the API can actually update afterward.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../../core/config.js';
import { openDatabase, _resetDbForTesting, exec, query } from '../../../core/db.js';
import {
  _runForTesting as runWatchdog,
  _setWedgeDepsForTesting as setWedgeDeps,
  _resetForTesting as resetWatchdog,
} from '../context-watchdog.js';
import { handleTaskQueueRoute } from '../../../api/task-queue.js';

const TEST_PORT = 19876;

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

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
  _resetConfigForTesting();
  _resetDbForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-wedge-gate2-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), 'agent:\n  name: test\n');
  loadConfig(tmpDir);
  openDatabase(tmpDir);
  resetWatchdog();

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
  setWedgeDeps(null);
  resetWatchdog();
  _resetDbForTesting();
  _resetConfigForTesting();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  return new Promise<void>((resolve, reject) => {
    server.close((err) => { if (err) reject(err); else resolve(); });
  });
}

describe('wedge GATE 2: assigned_to cleared on pending-reset (mutation-kill)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('PUT /api/orchestrator/tasks/:id succeeds after GATE 2 resets a task to pending', async () => {
    const extId = 'test-gate2-ext';

    // Seed an in_progress task with a non-null assigned_to and stale updated_at.
    // With wedge_timeout_minutes=1 the cutoff is 1 min ago; task at 2 min is caught.
    exec(
      `INSERT INTO tasks (external_id, kind, title, status, assigned_to, created_at, updated_at)
       VALUES (?, 'orchestrator', 'Gate-2 regression task', 'in_progress', 'worker-abc', ?, ?)`,
      extId,
      isoMinutesAgo(60),
      isoMinutesAgo(2),
    );

    // Signal (iii): garbled/feedback-prompt pane. Bypasses the multi-tick debounce
    // gate (WEDGE_DEBOUNCE_THRESHOLD), so a single runWatchdog() call deterministically
    // triggers restartWedgedOrchestrator(). GATE 2 re-selects frozen tasks independently
    // via updated_at < cutoffIso, catching the task seeded 2 min stale above.
    setWedgeDeps({
      isOrchestratorAlive: () => true,
      killOrchestratorSession: () => true,
      spawnOrchestratorSession: () => null,
      captureOrchestratorPane: () => 'How is Claude doing this session? [1] Great [2] Fine',
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    await runWatchdog({ wedge_timeout_minutes: 1 });

    // Precondition: confirm GATE 2 actually ran — task status must be 'pending'.
    // If this fails, the watchdog did not fire and the rest of the test is meaningless.
    const rows = query<{ status: string; assigned_to: string | null }>(
      'SELECT status, assigned_to FROM tasks WHERE external_id = ?',
      extId,
    );
    assert.equal(rows[0]?.status, 'pending',
      'GATE 2 must have reset the task to pending — if this fails, the watchdog did not fire');

    // PRIMARY ASSERTION — the mutation-kill target:
    // Without `assigned_to = NULL` in the GATE 2 UPDATE the PUT returns 400
    // ('pending tasks must have null assignee'). With the fix it returns 200.
    // No assertion on assigned_to precedes this PUT — the precondition above only
    // checks status, leaving the mutation-kill signal to the HTTP response code.
    const res = await request('PUT', `/api/orchestrator/tasks/${extId}`, { work_notes: 'regression check' });
    assert.equal(res.status, 200,
      `PUT /api/orchestrator/tasks/:id must return 200 after GATE 2 pending-reset, ` +
      `got ${res.status}: ${res.body}`);

    // Secondary: verify the DB row is clean (placed after the HTTP assertion so the
    // mutation-kill failure surface is the 400 response, not this check).
    assert.equal(rows[0]?.assigned_to, null,
      'GATE 2 must clear assigned_to to NULL; without this the PUT returns 400');
  });
});
