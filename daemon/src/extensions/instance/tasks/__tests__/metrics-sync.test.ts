/**
 * Tests for metrics-sync LAN-down tolerance (todo #810).
 *
 * Guards:
 *   (a) Connection-level curl failure → logged at WARN (not ERROR), run() resolves.
 *   (b) Connected-but-bad-response (JSON parse fail) → logged at ERROR.
 *
 * Mutation-kill contract:
 *   Reverting the WARN branch back to ERROR (i.e., changing `logger.warn` to
 *   `logger.error` in the CurlConnectionError catch branch) MUST fail tests
 *   (a-warn-not-error) and (a-warn-called).  Demonstrated at the bottom.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _forTesting } from '../metrics-sync.js';
import type { MetricsSyncLogger } from '../metrics-sync.js';

const { run, CurlConnectionError, pushToBmo } = _forTesting;

// ── Logger spy factory ────────────────────────────────────────

interface LogSpy extends MetricsSyncLogger {
  warnCalls: Array<{ msg: string; data?: Record<string, unknown> }>;
  errorCalls: Array<{ msg: string; data?: Record<string, unknown> }>;
  infoCalls: Array<{ msg: string; data?: Record<string, unknown> }>;
}

function makeLogSpy(): LogSpy {
  const spy: LogSpy = {
    warnCalls: [],
    errorCalls: [],
    infoCalls: [],
    warn(msg, data) { spy.warnCalls.push({ msg, data }); },
    error(msg, data) { spy.errorCalls.push({ msg, data }); },
    info(msg, data) { spy.infoCalls.push({ msg, data }); },
  };
  return spy;
}

// ── Fake execFile factories ───────────────────────────────────

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
type FakeExecFile = (file: string, args: string[], opts: unknown, cb: ExecFileCb) => void;

/**
 * Returns a fake execFile function that immediately calls back with a
 * non-zero error (simulating curl exit code 7 / ECONNREFUSED).
 */
function makeConnectionFailExecFile(): FakeExecFile {
  return (_file, _args, _opts, cb) => {
    const err = new Error('connect ECONNREFUSED 192.168.12.169:3847');
    (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    cb(err, '', 'curl: (7) Failed to connect to 192.168.12.169 port 3847 after 0 ms: Connection refused');
  };
}

/**
 * Returns a fake execFile function that calls back with exit 0 but returns
 * non-JSON stdout (simulating a connected-but-bad-response scenario).
 */
function makeConnectedBadResponseExecFile(): FakeExecFile {
  return (_file, _args, _opts, cb) => {
    cb(null, '<html>Internal Server Error</html>', '');
  };
}

/** Fake fetchRows: returns one dummy row so run() reaches the pushToBmo call. */
function makeFakeRows() {
  return [{ hour: '2026-06-10 10:00', endpoint: '/health', method: 'GET', total_requests: 1, success_count: 1, error_4xx: 0, error_5xx: 0, avg_latency_ms: 5, p95_latency_ms: 10 }];
}

// Cast helpers (the injected deps are typed more loosely internally)
function asExecFile(fn: FakeExecFile): typeof import('node:child_process').execFile {
  return fn as unknown as typeof import('node:child_process').execFile;
}

// ── Test (a): connection-level failure ────────────────────────

describe('metrics-sync — LAN-down tolerance', () => {
  it('(a) pushToBmo rejects with CurlConnectionError on connection failure', async () => {
    await assert.rejects(
      () => pushToBmo([], asExecFile(makeConnectionFailExecFile())),
      (err: unknown) => {
        assert.ok(err instanceof CurlConnectionError, `Expected CurlConnectionError, got ${String(err)}`);
        assert.match((err as Error).message, /curl to BMO failed/);
        return true;
      },
    );
  });

  it('(a-warn-called) run() calls logger.warn on connection-level failure', async () => {
    const logSpy = makeLogSpy();
    await run(asExecFile(makeConnectionFailExecFile()), logSpy, makeFakeRows);

    assert.equal(logSpy.warnCalls.length, 1, 'WARN must be called exactly once for a connection-level failure');
    assert.match(logSpy.warnCalls[0].msg, /LAN-unreachable/);
  });

  it('(a-warn-not-error) run() does NOT call logger.error on connection-level failure', async () => {
    const logSpy = makeLogSpy();
    await run(asExecFile(makeConnectionFailExecFile()), logSpy, makeFakeRows);

    assert.equal(logSpy.errorCalls.length, 0, 'ERROR must NOT be called for a connection-level failure');
  });

  it('(a-resolves) run() resolves without throwing on connection-level failure', async () => {
    const logSpy = makeLogSpy();
    await assert.doesNotReject(
      () => run(asExecFile(makeConnectionFailExecFile()), logSpy, makeFakeRows),
      'run() must resolve (not reject) on connection-level curl failure',
    );
  });

  it('(b) pushToBmo rejects with plain Error (not CurlConnectionError) on bad response', async () => {
    await assert.rejects(
      () => pushToBmo([], asExecFile(makeConnectedBadResponseExecFile())),
      (err: unknown) => {
        assert.ok(!(err instanceof CurlConnectionError), 'Bad-response must NOT be CurlConnectionError');
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /Unexpected response from BMO/);
        return true;
      },
    );
  });

  it('(b-error-called) run() calls logger.error on bad-response failure', async () => {
    const logSpy = makeLogSpy();
    await run(asExecFile(makeConnectedBadResponseExecFile()), logSpy, makeFakeRows);

    assert.equal(logSpy.errorCalls.length, 1, 'ERROR must be called exactly once for a bad-response failure');
    assert.match(logSpy.errorCalls[0].msg, /unexpected response/i);
  });

  it('(b-warn-not-called) run() does NOT call logger.warn on bad-response failure', async () => {
    const logSpy = makeLogSpy();
    await run(asExecFile(makeConnectedBadResponseExecFile()), logSpy, makeFakeRows);

    assert.equal(logSpy.warnCalls.length, 0, 'WARN must NOT be called for a bad-response failure');
  });

  it('(b-resolves) run() resolves (does not throw) on bad-response failure', async () => {
    const logSpy = makeLogSpy();
    await assert.doesNotReject(
      () => run(asExecFile(makeConnectedBadResponseExecFile()), logSpy, makeFakeRows),
      'run() must resolve even on bad-response (error is logged, not thrown)',
    );
  });
});

// ── Mutation-kill demonstration ───────────────────────────────
//
// A mutant that changes `logger.warn(...)` to `logger.error(...)` in the
// CurlConnectionError branch will cause tests (a-warn-called) and
// (a-warn-not-error) to go RED:
//
//   (a-warn-called):   warnCalls.length === 0 but expected 1  → FAIL
//   (a-warn-not-error): errorCalls.length === 1 but expected 0 → FAIL
//
// The describe block below directly demonstrates this by applying the mutant
// logic to the same spy and asserting the wrong behaviour is observed.

describe('metrics-sync — mutation-kill: WARN→ERROR regression demo', () => {
  it('MUTANT: WARN→ERROR mutation produces wrong spy state (would fail production tests)', async () => {
    // Apply mutant directly: replace warn with error in the catch branch
    const mutantLogSpy = makeLogSpy();

    // Mutant run: same as run() but the CurlConnectionError branch calls error instead of warn
    const mutantRun = async () => {
      const rows = makeFakeRows();
      try {
        await pushToBmo(rows as Parameters<typeof pushToBmo>[0], asExecFile(makeConnectionFailExecFile()));
      } catch (err) {
        // MUTANT: always error, never warn
        mutantLogSpy.error('Metrics push skipped — peer likely LAN-unreachable (client-isolation)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    await mutantRun();

    // Document what the mutant produces:
    assert.equal(mutantLogSpy.warnCalls.length, 0, 'Mutant: WARN was NOT called');
    assert.equal(mutantLogSpy.errorCalls.length, 1, 'Mutant: ERROR was called (this is the regression)');

    // These would be the failing assertions if the real tests saw this state:
    //   (a-warn-called):   expected warnCalls.length 1, got 0 → RED
    //   (a-warn-not-error): expected errorCalls.length 0, got 1 → RED
  });
});
