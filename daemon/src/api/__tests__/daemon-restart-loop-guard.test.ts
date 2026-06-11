/**
 * Regression test for todo #852 — restart-loop guard on POST /api/daemon/restart.
 *
 * Root cause / threat:
 *   A wedged or looping worker can hammer POST /api/daemon/restart, causing the
 *   daemon to restart continuously. The endpoint is intentionally ungated
 *   (no auth — workers are legitimate callers), so defense must come from an
 *   in-process sliding-window guard.
 *
 * Fix:
 *   After RESTART_LOOP_MAX_COUNT accepted requests within a
 *   RESTART_LOOP_WINDOW_MS sliding window, the (N+1)th request is refused
 *   with 429 and a warning is logged. Time is controlled via an injectable
 *   clock seam (_setNowFn) so tests do not depend on real wall-clock sleeps.
 *
 * Mutation-killer assertion (provably RED when guard is removed):
 *   The final request in the burst sequence must return 429.
 *   If the guard body is removed (the `if (_restartTimestamps.length >=
 *   RESTART_LOOP_MAX_COUNT)` block deleted), the (N+1)th call falls through
 *   to the normal 202 path → `assert.equal(lastStatus, 429)` goes RED.
 *
 * Additional assertions:
 *   - All N requests within the limit return 202.
 *   - Exactly 1 warning is emitted on the refused call.
 *   - After the window expires (fake clock advanced), the counter resets and
 *     new requests are accepted again (no permanent lockout).
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  handleRestartRoute,
  setShutdownFn,
  _resetRestartForTesting,
  _setNowFn,
  _setWarnFn,
  RESTART_LOOP_MAX_COUNT,
  RESTART_LOOP_WINDOW_MS,
} from '../restart.js';

// ── Constants ──────────────────────────────────────────────────────────────────

// Unique port — avoids collision with daemon-restart-deferred.test.ts (19901)
const TEST_PORT = 19902;

// ── Fake clock ────────────────────────────────────────────────────────────────

let fakeNowMs = 0;
const fakeClock = () => fakeNowMs;

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
  fakeNowMs = 0;
  _resetRestartForTesting();
  _setNowFn(fakeClock);
  // Suppress the real shutdown to prevent the deferred timer from calling process.exit
  setShutdownFn(async () => {});
});

afterEach(() => {
  _resetRestartForTesting();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/daemon/restart — restart-loop guard (todo #852)', () => {
  it(
    'allows exactly RESTART_LOOP_MAX_COUNT restarts, refuses the (N+1)th — mutation-killer for #852',
    async () => {
      const statuses: number[] = [];

      // Send RESTART_LOOP_MAX_COUNT + 1 requests, all within the same window.
      // All timestamps are fakeNowMs = 0 (no clock advance), so every request
      // is inside the window.
      for (let i = 0; i < RESTART_LOOP_MAX_COUNT + 1; i++) {
        const { status } = await post('/api/daemon/restart');
        statuses.push(status);
      }

      // ── PRIMARY MUTATION-KILLER ASSERTION ─────────────────────────────────
      // The last request (index N) must be refused.
      // If the guard block is removed: this returns 202 → RED.
      // With the guard intact: returns 429 → GREEN.
      const lastStatus = statuses[statuses.length - 1];
      assert.equal(
        lastStatus,
        429,
        `(N+1)th restart in-window must be refused with 429 (got ${lastStatus})`,
      );

      // ── SECONDARY: all first N requests must succeed ───────────────────────
      for (let i = 0; i < RESTART_LOOP_MAX_COUNT; i++) {
        assert.equal(
          statuses[i],
          202,
          `request ${i + 1} of ${RESTART_LOOP_MAX_COUNT} must succeed with 202`,
        );
      }
    },
  );

  it('emits exactly one warning when the guard fires', async () => {
    const warnings: Array<{ msg: string; data: { count: number; window_ms: number } }> = [];
    _setWarnFn((msg, data) => warnings.push({ msg, data }));

    // Exhaust the limit
    for (let i = 0; i < RESTART_LOOP_MAX_COUNT; i++) {
      await post('/api/daemon/restart');
    }
    // No warning yet — all within limit
    assert.equal(warnings.length, 0, 'no warning expected while within limit');

    // (N+1)th call — guard fires
    const { status } = await post('/api/daemon/restart');
    assert.equal(status, 429);

    // Exactly one warning logged
    assert.equal(warnings.length, 1, 'guard must emit exactly one warning on first refusal');
    assert.ok(
      warnings[0]!.msg.includes('restart-loop guard'),
      `warning message must mention "restart-loop guard", got: "${warnings[0]!.msg}"`,
    );
    assert.equal(warnings[0]!.data.count, RESTART_LOOP_MAX_COUNT);
    assert.equal(warnings[0]!.data.window_ms, RESTART_LOOP_WINDOW_MS);
  });

  it('429 response body contains error field and retry_after_seconds', async () => {
    // Exhaust the limit
    for (let i = 0; i < RESTART_LOOP_MAX_COUNT; i++) {
      await post('/api/daemon/restart');
    }
    const { status, body } = await post('/api/daemon/restart');
    assert.equal(status, 429);

    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(typeof parsed.error, 'string', 'response must have an error string');
    assert.equal(typeof parsed.retry_after_seconds, 'number', 'response must have retry_after_seconds');
    assert.ok((parsed.retry_after_seconds as number) > 0, 'retry_after_seconds must be positive');
  });

  it('Retry-After response header is set on 429', async () => {
    // Exhaust the limit
    for (let i = 0; i < RESTART_LOOP_MAX_COUNT; i++) {
      await post('/api/daemon/restart');
    }

    const headerValue = await new Promise<string | undefined>((resolve, reject) => {
      const opts: http.RequestOptions = {
        host: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/daemon/restart',
        method: 'POST',
        headers: { 'Content-Length': '0', Connection: 'close' },
        timeout: 5000,
      };
      const r = http.request(opts, (res) => {
        res.resume();
        resolve(res.headers['retry-after']);
      });
      r.on('error', reject);
      r.end();
    });

    assert.ok(headerValue !== undefined, 'Retry-After header must be present on 429');
    assert.ok(Number(headerValue) > 0, 'Retry-After value must be a positive integer (seconds)');
  });

  it('window resets after RESTART_LOOP_WINDOW_MS elapses (no permanent lockout)', async () => {
    // Exhaust the limit
    for (let i = 0; i < RESTART_LOOP_MAX_COUNT; i++) {
      await post('/api/daemon/restart');
    }
    // Verify the guard is active
    const { status: blockedStatus } = await post('/api/daemon/restart');
    assert.equal(blockedStatus, 429, 'guard must be active before window advance');

    // Advance the fake clock past the window boundary
    fakeNowMs = RESTART_LOOP_WINDOW_MS + 1;

    // The old timestamps are now outside the window — new requests should succeed
    const { status: afterExpiry } = await post('/api/daemon/restart');
    assert.equal(
      afterExpiry,
      202,
      'after window expiry, a new restart request must be accepted (no permanent lockout)',
    );
  });
});
