/**
 * #997 regression — retro auto-spawn fires on every terminal task regardless of config.
 *
 * RC1 (structural trigger): the else path in unified-tasks.ts and task-queue.ts called
 * _evalFn unconditionally, causing a retro to be attempted on every terminal task even
 * when retro was disabled or not warranted.
 *
 * RC2 (config-disable ineffective): config-watcher's reload() updated only its own local
 * _config copy, leaving config.ts's singleton (_config) pointing at the startup snapshot.
 * getSelfImprovementConfig() → loadConfig() therefore always returned stale config, so
 * disabling retros via POST /api/config/reload had no effect.
 *
 * Mutation-kill contract:
 *   Test (a) — RC1: reverts the _sic.retro.enabled gate → eval fn IS called → RED.
 *   Test (b) — RC2: reverts the applyConfig() call in loadAndApply → stale value returned → RED.
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
import { createConfigWatcher } from '../core/config-watcher.js';

// ── Ports (must not collide with other test files) ─────────────────────────
const PORT_RC1_UNIFIED = 19891;
const PORT_RC1_TASKQ   = 19892;

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

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Drain the microtask queue so non-blocking Promises (like _evalFn.catch) settle. */
const drainMicrotasks = (): Promise<void> => new Promise(r => setTimeout(r, 20));

// ── RC1 (a) — unified-tasks.ts retro gate ──────────────────────────────────

describe('#997 RC1-a: unified-tasks retro gate (retro disabled → eval fn skipped)', { concurrency: 1 }, () => {
  let server: http.Server;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-997-ut-'));

    // Prime config with NO self_improvement section → defaults to retro.enabled=false.
    // _resetConfigForTesting ensures no stale singleton from other tests.
    _resetConfigForTesting();
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      yaml.dump({ agent: { name: 'Test997' }, daemon: { port: 3847 } }),
    );
    loadConfig(tmpDir);

    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    // Suppress tmux injection; eval fn will be set per-test as a spy.
    _setTmuxInjectorForTesting(() => false);

    server = http.createServer((inReq, res) => {
      const url = new URL(inReq.url ?? '/', `http://localhost:${PORT_RC1_UNIFIED}`);
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

    await new Promise<void>((resolve) => server.listen(PORT_RC1_UNIFIED, '127.0.0.1', resolve));
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

  it('eval fn is NOT called when retro is disabled and task has no forced flags', async () => {
    // Confirm retro is disabled in our test config (mutation-kill baseline).
    const sic = getSelfImprovementConfig();
    assert.equal(sic.retro.enabled, false, 'Precondition: retro must be disabled in test config');

    // Set up spy — must NOT be called when retro is disabled.
    let evalCalled = false;
    _setEvaluateTaskFnForTesting(async () => { evalCalled = true; });

    // Seed an orchestrator task at in_progress so we can transition straight to completed.
    const extId = randomUUID();
    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, created_at, updated_at)
       VALUES (?, 'orchestrator', '#997 retro gate test', 'test', 'in_progress', 'medium', 'orchestrator', ?, ?)`,
      extId,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    // Drive the REAL terminal transition path through unified-tasks.ts.
    const res = await request(PORT_RC1_UNIFIED, 'PUT', `/api/tasks/${extId}`, { status: 'completed' });
    assert.equal(res.status, 200, `PUT /api/tasks/:id failed: ${res.body}`);

    // Drain microtasks so any non-blocking _evalFn().catch() fires.
    await drainMicrotasks();

    // Mutation-kill assertion: eval fn must NOT have been invoked.
    // Reverting the _sic.retro.enabled gate in unified-tasks.ts causes the else branch
    // to call _evalFn unconditionally → evalCalled = true → this assertion goes RED.
    assert.equal(
      evalCalled,
      false,
      'eval fn must NOT be called when retro.enabled=false (RC1 unified-tasks regression)',
    );
  });
});

// ── RC1 (a) — task-queue.ts retro gate ─────────────────────────────────────

describe('#997 RC1-a: task-queue retro gate (retro disabled → eval fn skipped)', { concurrency: 1 }, () => {
  let server: http.Server;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-997-tq-'));

    _resetConfigForTesting();
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      yaml.dump({ agent: { name: 'Test997TQ' }, daemon: { port: 3847 } }),
    );
    loadConfig(tmpDir);

    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    _tqSetTmuxInjector(() => false);

    server = http.createServer((inReq, res) => {
      const url = new URL(inReq.url ?? '/', `http://localhost:${PORT_RC1_TASKQ}`);
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

    await new Promise<void>((resolve) => server.listen(PORT_RC1_TASKQ, '127.0.0.1', resolve));
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

  it('eval fn is NOT called when retro is disabled and task has no forced flags', async () => {
    const sic = getSelfImprovementConfig();
    assert.equal(sic.retro.enabled, false, 'Precondition: retro must be disabled in test config');

    let evalCalled = false;
    _tqSetEvalFn(async () => { evalCalled = true; });

    // Create task via task-queue route and advance to terminal state.
    const createRes = await request(PORT_RC1_TASKQ, 'POST', '/api/orchestrator/tasks', {
      title: '#997 retro gate test',
      description: 'RC1 task-queue path',
    });
    assert.equal(createRes.status, 201, `POST /api/orchestrator/tasks failed: ${createRes.body}`);
    const taskId = (JSON.parse(createRes.body) as Record<string, unknown>).id as string;

    // Advance through the state machine to reach the terminal transition.
    const assignRes = await request(PORT_RC1_TASKQ, 'PUT', `/api/orchestrator/tasks/${taskId}`, {
      status: 'assigned', assignee: 'orchestrator',
    });
    assert.equal(assignRes.status, 200, `assign failed: ${assignRes.body}`);

    const wipRes = await request(PORT_RC1_TASKQ, 'PUT', `/api/orchestrator/tasks/${taskId}`, {
      status: 'in_progress',
    });
    assert.equal(wipRes.status, 200, `in_progress failed: ${wipRes.body}`);

    // Drive the REAL terminal transition path through task-queue.ts.
    const doneRes = await request(PORT_RC1_TASKQ, 'PUT', `/api/orchestrator/tasks/${taskId}`, {
      status: 'completed',
    });
    assert.equal(doneRes.status, 200, `completed failed: ${doneRes.body}`);

    await drainMicrotasks();

    // Mutation-kill assertion: eval fn must NOT have been invoked.
    // Reverting the _sic.retro.enabled gate in task-queue.ts causes the else branch
    // to call _evalFn unconditionally → evalCalled = true → this assertion goes RED.
    assert.equal(
      evalCalled,
      false,
      'eval fn must NOT be called when retro.enabled=false (RC1 task-queue regression)',
    );
  });
});

// ── RC2 (b) — config-watcher syncs singleton on reload ─────────────────────

describe('#997 RC2-b: config-watcher reload refreshes loadConfig() singleton', { concurrency: 1 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-997-cfg-'));
    _resetConfigForTesting();
  });

  afterEach(() => {
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getSelfImprovementConfig() reflects new value after reload (V1 → V2)', async () => {
    const configPath = path.join(tmpDir, 'kithkit.config.yaml');

    // V1: retro_all_terminal=true (distinctly non-default — default is false).
    fs.writeFileSync(configPath, yaml.dump({
      agent: { name: 'Test997Cfg' },
      daemon: { port: 3847 },
      self_improvement: { retro: { retro_all_terminal: true } },
    }));
    loadConfig(tmpDir);

    const v1 = getSelfImprovementConfig().retro.retro_all_terminal;
    assert.equal(v1, true, 'Precondition: V1 must be true (retro_all_terminal set in initial config)');

    // V2: flip retro_all_terminal to false.
    fs.writeFileSync(configPath, yaml.dump({
      agent: { name: 'Test997Cfg' },
      daemon: { port: 3847 },
      self_improvement: { retro: { retro_all_terminal: false } },
    }));

    // Trigger the REAL config-watcher reload path (not a direct loadConfig call).
    const initial = loadConfig(tmpDir);
    const watcher = createConfigWatcher(configPath, initial);
    const result = await watcher.reload();
    assert.equal(result.success, true, 'Watcher reload must succeed');
    watcher.stop();

    const v2 = getSelfImprovementConfig().retro.retro_all_terminal;

    // Mutation-kill assertion: V2 must be the new value (false), distinct from V1 (true).
    // Reverting the applyConfig(newConfig) call in config-watcher's loadAndApply causes
    // loadConfig() to return the stale startup snapshot → v2 === true (V1) → this assertion goes RED.
    assert.notEqual(v2, v1, 'getSelfImprovementConfig() must return new value after reload (RC2 regression)');
    assert.equal(v2, false, 'V2 must be false (the reloaded value), not the stale V1=true');
  });
});
