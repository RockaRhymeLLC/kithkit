/**
 * Regression test for todo #98 — daemon restart orphans triggering worker.
 *
 * Root cause: workers called `launchctl kickstart -k ...` directly to restart
 * the daemon. Because workers are async coroutines within the daemon process,
 * SIGTERM immediately killed them along with the daemon — the triggering worker
 * was orphaned mid-flight (never reached a terminal state).
 *
 * Fix (approach a): POST /api/daemon/restart responds 202 *before* scheduling
 * the actual shutdown via setTimeout(fn, DEFERRED_RESTART_DELAY_MS). The
 * calling worker receives its 202, completes any wrap-up steps, and exits
 * cleanly before the daemon goes down.
 *
 * Mutation-killer assertion (provably RED when fix is reverted):
 *   assert.equal(shutdownCallCount, 0) immediately after the 202 response.
 *   If the setTimeout is removed and shutdown() is called synchronously,
 *   shutdownCallCount will be 1 at that point → test goes RED.
 *
 * We also assert:
 *   - shutdown is called exactly once after DEFERRED_RESTART_DELAY_MS elapses
 *   - a second POST while a restart is already pending does NOT schedule
 *     a second shutdown call (idempotence guard)
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  handleRestartRoute,
  setShutdownFn,
  _resetRestartForTesting,
  DEFERRED_RESTART_DELAY_MS,
} from '../restart.js';

// ── Constants ──────────────────────────────────────────────────────────────────

// Unique port — avoids collision with other __tests__ suites
const TEST_PORT = 19901;

// Extra margin beyond the delay to let the timer fire reliably in CI
const TIMER_MARGIN_MS = 300;

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${TEST_PORT}`);
      handleRestartRoute(req, res, url.pathname).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      }).catch((err: unknown) => {
        res.writeHead(500);
        res.end(String(err));
      });
    });
    server.listen(TEST_PORT, '127.0.0.1', () => resolve());
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function post(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '0',
        'Connection': 'close',
      },
      timeout: 5000,
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('request timeout')); });
    r.end();
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(startServer);
after(stopServer);

beforeEach(() => {
  _resetRestartForTesting();
});

afterEach(() => {
  _resetRestartForTesting();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/daemon/restart — 202 before shutdown (core orphan-fix assertion)', () => {
  it(
    'returns 202 AND has not called shutdown synchronously — mutation-killer for #98',
    async () => {
      let shutdownCallCount = 0;

      // Inject a spy that tracks calls without actually exiting.
      setShutdownFn(async () => { shutdownCallCount++; });

      const { status } = await post('/api/daemon/restart');

      // ── PRIMARY ASSERTION (mutation-killer) ──────────────────────────────
      // If the fix is reverted (setTimeout removed, shutdown called sync),
      // shutdownCallCount will be 1 here → test goes RED.
      assert.equal(
        shutdownCallCount,
        0,
        'shutdown must NOT be called synchronously — worker must receive 202 before daemon exits',
      );

      // ── SECONDARY: correct HTTP status ───────────────────────────────────
      assert.equal(status, 202, 'endpoint must respond 202 Accepted');
    },
  );

  it('calls shutdown exactly once after DEFERRED_RESTART_DELAY_MS', async () => {
    let shutdownCallCount = 0;
    setShutdownFn(async () => { shutdownCallCount++; });

    await post('/api/daemon/restart');

    // Before the delay elapses — shutdown must still be pending
    assert.equal(shutdownCallCount, 0, 'shutdown must not fire before the delay');

    // Wait for the timer to fire
    await new Promise<void>((resolve) =>
      setTimeout(resolve, DEFERRED_RESTART_DELAY_MS + TIMER_MARGIN_MS),
    );

    assert.equal(shutdownCallCount, 1, 'shutdown must be called exactly once after the delay');
  });
});

describe('POST /api/daemon/restart — response shape', () => {
  it('response body contains message and delay_ms fields', async () => {
    // Prevent the timer from firing during this test
    setShutdownFn(async () => {});

    const { status, body } = await post('/api/daemon/restart');

    assert.equal(status, 202);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(typeof parsed.message, 'string');
    assert.equal(parsed.delay_ms, DEFERRED_RESTART_DELAY_MS);
  });
});

describe('POST /api/daemon/restart — idempotence guard', () => {
  it('a second POST while restart is pending does not schedule a second shutdown', async () => {
    let shutdownCallCount = 0;
    setShutdownFn(async () => { shutdownCallCount++; });

    // First request — schedules the deferred restart
    const r1 = await post('/api/daemon/restart');
    assert.equal(r1.status, 202);

    // Second request — should be a no-op (guard: only one pending restart at a time)
    const r2 = await post('/api/daemon/restart');
    assert.equal(r2.status, 202);

    // Wait past the delay
    await new Promise<void>((resolve) =>
      setTimeout(resolve, DEFERRED_RESTART_DELAY_MS + TIMER_MARGIN_MS),
    );

    // Shutdown must have been called exactly once, not twice
    assert.equal(shutdownCallCount, 1, 'idempotence guard must prevent double shutdown');
  });
});

describe('POST /api/daemon/restart — non-POST methods', () => {
  it('does not handle GET (returns false → 404)', async () => {
    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const opts: http.RequestOptions = {
        host: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/daemon/restart',
        method: 'GET',
        headers: { Connection: 'close' },
        timeout: 5000,
      };
      const req = http.request(opts, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.status, 404, 'GET must not be handled by this route');
  });
});

describe('POST /api/daemon/restart — unrelated paths not matched', () => {
  it('does not handle /api/daemon/restart/extra', async () => {
    const r = await post('/api/daemon/restart/extra');
    assert.equal(r.status, 404);
  });

  it('does not handle /api/config/reload', async () => {
    const r = await post('/api/config/reload');
    assert.equal(r.status, 404);
  });
});
