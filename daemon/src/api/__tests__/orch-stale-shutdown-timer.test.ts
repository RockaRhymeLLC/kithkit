/**
 * Mutation-kill tests: stale shutdown-timer instance guard (fix(3), #2304/#1946/#448).
 *
 * Tests the started_at identity guard added to the /api/orchestrator/shutdown
 * force-kill timer in orchestrator.ts.
 *
 * OBSERVED FAILURE SCENARIO:
 *   1. /shutdown arms a 60s force-kill timer, captures started_at = "A"
 *   2. Wedged session is hard-killed externally; daemon auto-respawns (started_at = "B")
 *   3. Stale timer fires → without the guard it kills the innocent new session
 *   4. With the guard: currentStartedAt ("B") ≠ armedStartedAt ("A") → skips kill
 *
 * PRIMARY MUTATION-KILL ASSERTION (test 1):
 *   Arm timer for session A. Simulate replacement: getOrchStartedAt returns B at fire time.
 *   Timer MUST NOT call killOrchestratorSession().
 *   If the identity guard is removed → kill IS called → test RED.
 *
 * POSITIVE CASE (test 2 — graceful shutdown still works):
 *   Arm timer for session A. getOrchStartedAt returns A at fire time (no replacement).
 *   Timer MUST call killOrchestratorSession().
 *
 * CI placement: daemon/src/api/__tests__/ → daemon/dist/api/__tests__/
 *   Found by `node --test dist/**\/*.test.js`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec } from '../../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../../core/config.js';
import {
  handleOrchestratorRoute,
  _setDepsForTesting as setOrchDeps,
  _setShutdownTimeoutForTesting,
} from '../orchestrator.js';

// ── HTTP test server ──────────────────────────────────────────
// Use port 0 (OS-assigned) to avoid port-reuse/TIME_WAIT conflicts between tests.

let activePort = 0;

async function startServer(): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${activePort}`);
    const handled = await handleOrchestratorRoute(req, res, url.pathname);
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  activePort = addr.port;
  return server;
}

async function post(urlPath: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: activePort, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, res => {
      let buf = '';
      res.on('data', (c: Buffer) => { buf += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

let tmpDir: string;
let server: http.Server;

function insertOrchAgent(startedAt: string): void {
  exec(
    `INSERT INTO agents (id, type, profile, status, tmux_session, started_at, created_at, updated_at)
     VALUES ('orchestrator', 'orchestrator', 'orchestrator', 'running', 'orch1', ?, ?, ?)`,
    startedAt, startedAt, startedAt,
  );
}

async function setup(): Promise<void> {
  _resetConfigForTesting();
  _resetDbForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-shutdown-timer-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), 'agent:\n  name: test\n');
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  // Use short timer so tests don't take 60 seconds
  _setShutdownTimeoutForTesting(50);
  server = await startServer();
}

async function teardown(): Promise<void> {
  setOrchDeps(null);
  _setShutdownTimeoutForTesting(null);
  _resetDbForTesting();
  _resetConfigForTesting();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── PRIMARY MUTATION-KILL TEST ────────────────────────────────

describe('orch-stale-shutdown-timer: identity guard (fix(3), mutation-kill)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('timer does NOT kill session when started_at changed (session replaced) — mutation-kill proof', async () => {
    const sessionAStartedAt = isoMinutesAgo(60);  // identity of the session being shut down
    const sessionBStartedAt = isoMinutesAgo(1);   // identity of the fresh replacement session

    insertOrchAgent(sessionAStartedAt);

    // Simulate scenario:
    //   - At arm time: getOrchStartedAt returns sessionA
    //   - At fire time: getOrchStartedAt returns sessionB (session was replaced)
    //   - isOrchestratorAlive returns true throughout (the new session is alive)

    let getStartedAtCallCount = 0;
    let killCalled = false;

    setOrchDeps({
      // Orch alive throughout — the new session is running
      isOrchestratorAlive: () => true,
      getOrchestratorState: () => 'waiting',
      // First call (arm time): return A; second call (fire time): return B
      getOrchStartedAt: () => {
        getStartedAtCallCount++;
        return getStartedAtCallCount <= 1 ? sessionAStartedAt : sessionBStartedAt;
      },
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      sendMessage: () => ({ messageId: 1, delivered: false }),
      injectMessage: () => true,
    });

    const res = await post('/api/orchestrator/shutdown', {});
    assert.equal(res.status, 200, 'shutdown request should succeed (200)');
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'shutdown_requested', `expected shutdown_requested, got ${body.status}`);

    // Wait for the 50ms timer to fire + some buffer
    await new Promise(resolve => setTimeout(resolve, 300));

    assert.equal(killCalled, false,
      'killOrchestratorSession MUST NOT be called when the session was replaced — ' +
      'if this fails, the identity guard was removed (mutation-kill proof for fix(3))');

    assert.ok(getStartedAtCallCount >= 2,
      `getOrchStartedAt must be called at least twice (arm + fire); got ${getStartedAtCallCount}`);
  });

  it('timer DOES kill session when started_at unchanged — graceful shutdown still works', async () => {
    const sessionAStartedAt = isoMinutesAgo(60);
    insertOrchAgent(sessionAStartedAt);

    let killCalled = false;

    setOrchDeps({
      isOrchestratorAlive: () => true,
      getOrchestratorState: () => 'waiting',
      // Always returns A — no session replacement
      getOrchStartedAt: () => sessionAStartedAt,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      sendMessage: () => ({ messageId: 1, delivered: false }),
      injectMessage: () => true,
    });

    const res = await post('/api/orchestrator/shutdown', {});
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'shutdown_requested');

    await new Promise(resolve => setTimeout(resolve, 300));

    assert.equal(killCalled, true,
      'killOrchestratorSession MUST be called when the same session is alive at fire time — ' +
      'graceful-shutdown force-kill path must still work after the fix');
  });

  it('timer skips kill when orch already exited gracefully (isOrchestratorAlive false at fire time)', async () => {
    const sessionAStartedAt = isoMinutesAgo(60);
    insertOrchAgent(sessionAStartedAt);

    let killCalled = false;
    let callCount = 0;

    setOrchDeps({
      // First call (in handler): alive → arm timer
      // Second call (in timer): dead → skip kill
      isOrchestratorAlive: () => {
        callCount++;
        return callCount <= 1; // true at arm-check, false at fire-check
      },
      getOrchestratorState: () => 'waiting',
      getOrchStartedAt: () => sessionAStartedAt,
      killOrchestratorSession: () => { killCalled = true; return true; },
      spawnOrchestratorSession: () => 'orch1',
      sendMessage: () => ({ messageId: 1, delivered: false }),
      injectMessage: () => true,
    });

    const res = await post('/api/orchestrator/shutdown', {});
    assert.equal(res.status, 200);

    await new Promise(resolve => setTimeout(resolve, 300));

    assert.equal(killCalled, false,
      'timer must skip kill when orch already exited gracefully (isOrchestratorAlive is false at fire time)');
  });
});
