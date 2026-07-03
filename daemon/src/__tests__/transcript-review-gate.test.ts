/**
 * #1017 regression — comms-correction _evalFn path and stats.ts transcript_review_enabled.
 *
 * Three call-sites are tested:
 *   (a) unified-tasks.ts comms-correction block (PUT comms_outcome=corrected/redirected)
 *   (b) task-queue.ts comms-correction block (PUT comms_outcome=corrected/redirected)
 *   (c) stats.ts transcript_review_enabled field reflects config
 *
 * Mutation-kill contract:
 *   Tests (a)/(b): reverts the `if (_getSIC().retro.enabled)` gate in the comms-correction
 *     block → eval fn IS called when retro is disabled → RED.
 *   Test (c): reverts the `transcript_review_enabled` field in stats return → field missing
 *     or wrong value → RED.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { openDatabase, _resetDbForTesting, exec } from '../core/db.js';
import {
  handleUnifiedTasksRoute,
  _setTmuxInjectorForTesting,
  _setEvaluateTaskFnForTesting,
} from '../api/unified-tasks.js';
import {
  handleTaskQueueRoute,
  _setTmuxInjectorForTesting as _tqSetTmuxInjector,
  _setEvaluateTaskFnForTesting as _tqSetEvalFn,
} from '../api/task-queue.js';
import { loadConfig, _resetConfigForTesting } from '../core/config.js';
import { getSelfImprovementConfig } from '../self-improvement/config.js';
import { getSelfImprovementStats } from '../self-improvement/stats.js';
import { getDatabase } from '../core/db.js';

// ── Ports (must not collide with other test files) ─────────────────────────
const PORT_1017_UNIFIED = 19893;
const PORT_1017_TASKQ   = 19894;

// ── HTTP helper ─────────────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
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

/** Drain the microtask queue so non-blocking Promises (like _evalFn.catch) settle. */
const drainMicrotasks = (): Promise<void> => new Promise(r => setTimeout(r, 20));

// ── (a) unified-tasks.ts comms-correction gate ─────────────────────────────

describe('#1017 comms-correction gate: unified-tasks (retro disabled → eval fn skipped)', { concurrency: 1 }, () => {
  let server: http.Server;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-1017-ut-'));

    _resetConfigForTesting();
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      yaml.dump({ agent: { name: 'Test1017UT' }, daemon: { port: 3847 } }),
    );
    loadConfig(tmpDir);

    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    _setTmuxInjectorForTesting(() => false);

    server = http.createServer((inReq, res) => {
      const url = new URL(inReq.url ?? '/', `http://localhost:${PORT_1017_UNIFIED}`);
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

    await new Promise<void>((resolve) => server.listen(PORT_1017_UNIFIED, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    _setTmuxInjectorForTesting(null);
    _setEvaluateTaskFnForTesting(null);
    _resetConfigForTesting();
    _resetDbForTesting();
    await new Promise<void>((resolve) => {
      if (server?.listening) {
        server.close(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); resolve(); });
      } else {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      }
    });
  });

  it('eval fn is NOT called on comms_outcome=corrected when retro is disabled', async () => {
    // Confirm retro is disabled in our test config.
    const sic = getSelfImprovementConfig();
    assert.equal(sic.retro.enabled, false, 'Precondition: retro must be disabled in test config');

    // Set up spy — must NOT be called when retro is disabled.
    let evalCalled = false;
    _setEvaluateTaskFnForTesting(async () => { evalCalled = true; });

    // Seed a completed orchestrator task with kind='orchestrator' and external_id set.
    // The comms-correction block in unified-tasks.ts requires kind='orchestrator' && external_id.
    const extId = randomUUID();
    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', '#1017 comms-correction gate test', 'test', 'completed', 'medium', 'orchestrator', ?, ?)`,
      extId,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    // Drive the REAL comms-correction path through unified-tasks.ts.
    // Setting comms_outcome='corrected' on a completed task (comms-feedback-only update).
    const res = await request(PORT_1017_UNIFIED, 'PUT', `/api/tasks/${extId}`, {
      comms_outcome: 'corrected',
    });
    assert.equal(res.status, 200, `PUT /api/tasks/:id failed: ${res.body}`);

    // Drain microtasks so any non-blocking _evalFn().catch() fires.
    await drainMicrotasks();

    // Mutation-kill assertion: eval fn must NOT have been invoked.
    // Reverting the `if (_getSIC().retro.enabled)` gate in unified-tasks.ts causes
    // _evalFn to be called unconditionally → evalCalled = true → this assertion goes RED.
    assert.equal(
      evalCalled,
      false,
      'eval fn must NOT be called on comms correction when retro.enabled=false (#1017 unified-tasks regression)',
    );
  });

  it('eval fn is NOT called on comms_outcome=redirected when retro is disabled', async () => {
    const sic = getSelfImprovementConfig();
    assert.equal(sic.retro.enabled, false, 'Precondition: retro must be disabled');

    let evalCalled = false;
    _setEvaluateTaskFnForTesting(async () => { evalCalled = true; });

    const extId = randomUUID();
    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', '#1017 comms-redirect gate test', 'test', 'completed', 'medium', 'orchestrator', ?, ?)`,
      extId,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const res = await request(PORT_1017_UNIFIED, 'PUT', `/api/tasks/${extId}`, {
      comms_outcome: 'redirected',
    });
    assert.equal(res.status, 200, `PUT /api/tasks/:id failed: ${res.body}`);

    await drainMicrotasks();

    assert.equal(
      evalCalled,
      false,
      'eval fn must NOT be called on comms redirect when retro.enabled=false (#1017 unified-tasks)',
    );
  });
});

// ── (b) task-queue.ts comms-correction gate ────────────────────────────────

describe('#1017 comms-correction gate: task-queue (retro disabled → eval fn skipped)', { concurrency: 1 }, () => {
  let server: http.Server;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-1017-tq-'));

    _resetConfigForTesting();
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      yaml.dump({ agent: { name: 'Test1017TQ' }, daemon: { port: 3847 } }),
    );
    loadConfig(tmpDir);

    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    _tqSetTmuxInjector(() => false);

    server = http.createServer((inReq, res) => {
      const url = new URL(inReq.url ?? '/', `http://localhost:${PORT_1017_TASKQ}`);
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

    await new Promise<void>((resolve) => server.listen(PORT_1017_TASKQ, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    _tqSetTmuxInjector(null);
    _tqSetEvalFn(null);
    _resetConfigForTesting();
    _resetDbForTesting();
    await new Promise<void>((resolve) => {
      if (server?.listening) {
        server.close(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); resolve(); });
      } else {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      }
    });
  });

  it('eval fn is NOT called on comms_outcome=corrected when retro is disabled', async () => {
    const sic = getSelfImprovementConfig();
    assert.equal(sic.retro.enabled, false, 'Precondition: retro must be disabled in test config');

    let evalCalled = false;
    _tqSetEvalFn(async () => { evalCalled = true; });

    // Create task via task-queue route.
    const createRes = await request(PORT_1017_TASKQ, 'POST', '/api/orchestrator/tasks', {
      title: '#1017 comms-correction gate test (task-queue)',
      description: 'comms-correction path gate test',
    });
    assert.equal(createRes.status, 201, `POST /api/orchestrator/tasks failed: ${createRes.body}`);
    const taskId = (JSON.parse(createRes.body) as Record<string, unknown>).id as string;

    // Advance to completed so comms_outcome can be set (comms-feedback on terminal task).
    await request(PORT_1017_TASKQ, 'PUT', `/api/orchestrator/tasks/${taskId}`, { status: 'assigned', assignee: 'orchestrator' });
    await request(PORT_1017_TASKQ, 'PUT', `/api/orchestrator/tasks/${taskId}`, { status: 'in_progress' });
    await request(PORT_1017_TASKQ, 'PUT', `/api/orchestrator/tasks/${taskId}`, { status: 'completed' });

    // Reset the spy after the terminal transition (which has its own retro eval path).
    evalCalled = false;

    // Drive the REAL comms-correction path through task-queue.ts.
    const corrRes = await request(PORT_1017_TASKQ, 'PUT', `/api/orchestrator/tasks/${taskId}`, {
      comms_outcome: 'corrected',
    });
    assert.equal(corrRes.status, 200, `PUT comms_outcome failed: ${corrRes.body}`);

    await drainMicrotasks();

    // Mutation-kill assertion: eval fn must NOT have been invoked via the comms-correction path.
    // Reverting the `if (_getSIC().retro.enabled)` gate in task-queue.ts causes
    // _evalFn to be called unconditionally → evalCalled = true → this assertion goes RED.
    assert.equal(
      evalCalled,
      false,
      'eval fn must NOT be called on comms correction when retro.enabled=false (#1017 task-queue regression)',
    );
  });
});

// ── (c) stats.ts transcript_review_enabled field ───────────────────────────

describe('#1017 stats: transcript_review_enabled reflects config', { concurrency: 1 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-1017-stats-'));
    _resetConfigForTesting();
    _resetDbForTesting();
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('transcript_review_enabled is true when config enables transcript_review', async () => {
    // Set transcript_review.enabled=true — distinctly non-default (default is false).
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      yaml.dump({
        agent: { name: 'Test1017Stats' },
        daemon: { port: 3847 },
        self_improvement: { transcript_review: { enabled: true } },
      }),
    );
    loadConfig(tmpDir);
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    const db = getDatabase();
    const stats = await getSelfImprovementStats(db);

    // Mutation-kill assertion: transcript_review_enabled must be true (non-default).
    // Reverting the `transcript_review_enabled: config.transcript_review.enabled` line
    // in stats.ts causes this field to be missing or false → this assertion goes RED.
    assert.equal(
      stats.transcript_review_enabled,
      true,
      'transcript_review_enabled must be true when self_improvement.transcript_review.enabled=true (#1017 stats)',
    );

    // Also verify default (false) remains the baseline.
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      yaml.dump({ agent: { name: 'Test1017StatsOff' }, daemon: { port: 3847 } }),
    );
    loadConfig(tmpDir);
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    const db2 = getDatabase();
    const stats2 = await getSelfImprovementStats(db2);
    assert.equal(
      stats2.transcript_review_enabled,
      false,
      'transcript_review_enabled must be false by default',
    );
  });

  it('transcript_review_enabled is false when config explicitly disables transcript_review (#1022)', async () => {
    // Explicitly set transcript_review.enabled=false in config.
    // This is DISTINCT from the default/absent case: here the config key is PRESENT with
    // value false. It pins the stats wiring against mutations that check object-presence
    // rather than reading the `.enabled` property (e.g. `!!config.transcript_review` would
    // return true here because the object exists, but `.enabled` is false).
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      yaml.dump({
        agent: { name: 'Test1022StatsDisabled' },
        daemon: { port: 3847 },
        self_improvement: { transcript_review: { enabled: false } },
      }),
    );
    loadConfig(tmpDir);
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    const db = getDatabase();
    const stats = await getSelfImprovementStats(db);

    // Mutation-kill assertion: transcript_review_enabled must be false (explicit disabled).
    // A mutation that reads `!!config.transcript_review` (object presence) instead of
    // `config.transcript_review.enabled` would return true here (the object IS present) →
    // this assertion goes RED with a VALUE mismatch, not a compile error.
    assert.equal(
      stats.transcript_review_enabled,
      false,
      'transcript_review_enabled must be false when self_improvement.transcript_review.enabled=false (#1022)',
    );
  });
});
