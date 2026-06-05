/**
 * Regression test: unified-tasks.ts tmux injector seam — #353 follow-up.
 *
 * Verifies that _setTmuxInjectorForTesting correctly intercepts every
 * notification-emitter call site in the unified-tasks route handler, and that
 * the real injectMessage in tmux.ts is NOT called when the stub is active.
 *
 * Background (#353 / #306 context):
 *   - #306 added a test-injectable seam (_setTmuxInjectorForTesting) to
 *     task-queue.ts so that tests could fully replace injectMessage without
 *     touching the real tmux module.
 *   - #353 added a defence-in-depth guard (isUnderTestRunner()) inside
 *     tmux.ts::injectMessage itself.
 *   - unified-tasks.ts was introduced after #306 but without the seam:
 *     its notification call sites imported and called defaultInjectMessage
 *     directly, so every test that exercised a notification path would
 *     increment _injectionAttempts in tmux.ts (even though no real I/O fired
 *     thanks to the #353 guard).  This PR closes that gap.
 *
 * Covers the notification call sites in unified-tasks.ts:
 *   - plan submission   → _injectMessage('comms', ...)       (/submit-plan)
 *   - plan approval     → _injectMessage('orchestrator', ...) (/approve-plan)
 *   - plan rejection    → _injectMessage('orchestrator', ...) (/reject-plan)
 *   - task cancellation → _injectMessage('comms', ...)        (/cancel)
 *   - terminal status   → _injectMessage('comms', ...)        (PUT status=completed)
 *   - progress activity → _injectMessage('comms', ...)        (POST /activity progress)
 *
 * Each "stub intercepts" test asserts:
 *   (a) stub was called ≥ 1 time (the seam is wired correctly), AND
 *   (b) _injectionAttempts === 0 (the real tmux.ts function was NOT called).
 *
 * The final "guard-fallback" test removes the seam and confirms that the
 * outer KITHKIT_SUPPRESS_NOTIFICATIONS layer prevents real I/O
 * (asserts _injectionAttempts === 0; does NOT exercise the #353 isUnderTestRunner guard).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import {
  handleUnifiedTasksRoute,
  _setTmuxInjectorForTesting,
  _setEvaluateTaskFnForTesting,
} from '../unified-tasks.js';
import { _getInjectionAttempts, _resetInjectionAttempts } from '../../agents/tmux.js';

const TEST_PORT = 19897;

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

describe('unified-tasks tmux seam (#353 follow-up)', () => {
  before((): Promise<void> => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-ut-seam-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    // Suppress retro evaluation — no real workers in unit tests
    _setEvaluateTaskFnForTesting(async () => {});

    server = http.createServer((inReq, res) => {
      const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
      res.setHeader('X-Timestamp', new Date().toISOString());
      handleUnifiedTasksRoute(inReq, res, url.pathname, url.searchParams)
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
  });

  after((): Promise<void> => {
    _setTmuxInjectorForTesting(null);
    _setEvaluateTaskFnForTesting(null);
    _resetInjectionAttempts();
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
  });

  /** Install the stub injector; return a counter accessor and reset real tmux counters. */
  function installStub(): { count: () => number } {
    let n = 0;
    _setTmuxInjectorForTesting((_agentId: string, _text: string) => { n++; return false; });
    _resetInjectionAttempts();
    return { count: () => n };
  }

  /**
   * Create a `todo`-kind task. Todo tasks bypass the orchestrator state machine
   * (any valid status transition is accepted), which keeps test setup minimal.
   */
  async function createTodoTask(title: string): Promise<number> {
    const res = await request('POST', '/api/tasks', { title, kind: 'todo' });
    assert.equal(res.status, 201, `create todo task failed: ${res.body}`);
    return (JSON.parse(res.body) as { id: number }).id;
  }

  /**
   * Create an `orchestrator`-kind task and walk it to `in_progress` via the
   * mandatory state machine path: pending → assigned → in_progress.
   */
  async function createInProgressOrchTask(title: string): Promise<number> {
    const res = await request('POST', '/api/tasks', { title, kind: 'orchestrator' });
    assert.equal(res.status, 201, `create orch task failed: ${res.body}`);
    const id = (JSON.parse(res.body) as { id: number }).id;

    const r1 = await request('PUT', `/api/tasks/${id}`, { status: 'assigned', assigned_to: 'orchestrator' });
    assert.equal(r1.status, 200, `pending→assigned failed: ${r1.body}`);

    const r2 = await request('PUT', `/api/tasks/${id}`, { status: 'in_progress' });
    assert.equal(r2.status, 200, `assigned→in_progress failed: ${r2.body}`);

    return id;
  }

  // ── Terminal notification (→ completed) ─────────────────────

  it('terminal PUT (→ completed) — stub intercepts; real injectMessage not called', async () => {
    // todo tasks bypass state machine — can go pending → completed directly
    const stub = installStub();
    const id = await createTodoTask('terminal-completed');

    const res = await request('PUT', `/api/tasks/${id}`, {
      status: 'completed',
      result: 'seam test result',
    });
    assert.equal(res.status, 200, `PUT completed: ${res.body}`);

    assert.ok(stub.count() > 0,
      `expected stub to be called for terminal→completed notification, got ${stub.count()}`);
    assert.equal(_getInjectionAttempts(), 0,
      `expected 0 real tmux injection attempts, got ${_getInjectionAttempts()}`);
  });

  // ── Task cancellation ────────────────────────────────────────

  it('task cancel — stub intercepts; real injectMessage not called', async () => {
    // pending → cancelled is valid for both todo and orchestrator kinds
    const stub = installStub();
    const id = await createTodoTask('cancel-test');

    const res = await request('POST', `/api/tasks/${id}/cancel`);
    assert.equal(res.status, 200, `cancel: ${res.body}`);

    assert.ok(stub.count() > 0,
      `expected stub to be called for cancel notification, got ${stub.count()}`);
    assert.equal(_getInjectionAttempts(), 0,
      `expected 0 real tmux injection attempts, got ${_getInjectionAttempts()}`);
  });

  // ── Plan submission ──────────────────────────────────────────

  it('plan submission — stub intercepts; real injectMessage not called', async () => {
    // submit-plan requires status=in_progress; use orchestrator task + full path
    const stub = installStub();
    const id = await createInProgressOrchTask('plan-submit-test');

    const res = await request('POST', `/api/tasks/${id}/submit-plan`, {
      plan: 'Step 1: seam test\nStep 2: done',
    });
    assert.equal(res.status, 200, `submit-plan: ${res.body}`);

    assert.ok(stub.count() > 0,
      `expected stub to be called for plan-submission notification, got ${stub.count()}`);
    assert.equal(_getInjectionAttempts(), 0,
      `expected 0 real tmux injection attempts, got ${_getInjectionAttempts()}`);
  });

  // ── Plan approval ────────────────────────────────────────────

  it('plan approval — stub intercepts; real injectMessage not called', async () => {
    // Set up: create orch task, reach in_progress, submit plan (→ awaiting_approval)
    const id = await createInProgressOrchTask('plan-approve-test');
    const submitRes = await request('POST', `/api/tasks/${id}/submit-plan`, { plan: 'test plan' });
    assert.equal(submitRes.status, 200, `submit-plan setup failed: ${submitRes.body}`);

    const stub = installStub();
    const res = await request('POST', `/api/tasks/${id}/approve-plan`);
    assert.equal(res.status, 200, `approve-plan: ${res.body}`);

    assert.ok(stub.count() > 0,
      `expected stub to be called for plan-approval notification, got ${stub.count()}`);
    assert.equal(_getInjectionAttempts(), 0,
      `expected 0 real tmux injection attempts, got ${_getInjectionAttempts()}`);
  });

  // ── Plan rejection ───────────────────────────────────────────

  it('plan rejection — stub intercepts; real injectMessage not called', async () => {
    // Set up: create orch task, reach in_progress, submit plan (→ awaiting_approval)
    const id = await createInProgressOrchTask('plan-reject-test');
    const submitRes = await request('POST', `/api/tasks/${id}/submit-plan`, { plan: 'test plan' });
    assert.equal(submitRes.status, 200, `submit-plan setup failed: ${submitRes.body}`);

    const stub = installStub();
    const res = await request('POST', `/api/tasks/${id}/reject-plan`, { reason: 'seam test' });
    assert.equal(res.status, 200, `reject-plan: ${res.body}`);

    assert.ok(stub.count() > 0,
      `expected stub to be called for plan-rejection notification, got ${stub.count()}`);
    assert.equal(_getInjectionAttempts(), 0,
      `expected 0 real tmux injection attempts, got ${_getInjectionAttempts()}`);
  });

  // ── Progress activity ────────────────────────────────────────

  it('progress activity — stub intercepts; real injectMessage not called', async () => {
    const stub = installStub();
    const id = await createTodoTask('progress-activity-test');

    const res = await request('POST', `/api/tasks/${id}/activity`, {
      type: 'progress',
      message: 'step 1 done',
      agent: 'orchestrator',
    });
    assert.equal(res.status, 201, `post activity: ${res.body}`);

    assert.ok(stub.count() > 0,
      `expected stub to be called for progress-activity notification, got ${stub.count()}`);
    assert.equal(_getInjectionAttempts(), 0,
      `expected 0 real tmux injection attempts, got ${_getInjectionAttempts()}`);
  });

  // ── Guard fallback (no seam installed) ──────────────────────

  it('seam restore (null) — KITHKIT_SUPPRESS_NOTIFICATIONS blocks defaultInjectMessage before counter', async () => {
    // Restore to default (no stub). The test suite runs with KITHKIT_SUPPRESS_NOTIFICATIONS=1,
    // which causes injectMessage to return before incrementing _injectionAttempts.
    // This confirms the two-layer defence:
    //   1. KITHKIT_SUPPRESS_NOTIFICATIONS (test-runner env, outermost)
    //   2. isUnderTestRunner() guard (#353, inner defence-in-depth)
    _setTmuxInjectorForTesting(null);
    _resetInjectionAttempts();

    const id = await createTodoTask('suppress-fallback-test');
    const res = await request('PUT', `/api/tasks/${id}`, {
      status: 'completed',
      result: 'suppress fallback',
    });
    assert.equal(res.status, 200, `PUT completed: ${res.body}`);

    // Counter stays at 0 because KITHKIT_SUPPRESS_NOTIFICATIONS short-circuits
    // injectMessage before _injectionAttempts is incremented — no real I/O.
    assert.equal(
      _getInjectionAttempts(),
      0,
      `expected 0 (KITHKIT_SUPPRESS_NOTIFICATIONS suppresses before counter), got ${_getInjectionAttempts()}`,
    );
  });
});
