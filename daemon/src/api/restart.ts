/**
 * Daemon Restart API — deferred-restart endpoint.
 *
 * Routes:
 *   POST /api/daemon/restart — Schedule a graceful daemon restart
 *
 * WHY THIS EXISTS (todo #98):
 *   When a coding worker calls `launchctl kickstart -k ...` directly, the
 *   daemon receives SIGTERM and immediately exits. Because workers are
 *   async coroutines within the daemon process, they die with it — the
 *   triggering worker is orphaned mid-flight and never reaches a terminal
 *   state.
 *
 *   This endpoint provides a safe alternative: it responds 202 immediately,
 *   then defers the actual shutdown by DEFERRED_RESTART_DELAY_MS so the
 *   calling worker has time to receive the response, complete any wrap-up
 *   steps, and exit cleanly before the daemon goes down.
 *
 * Workers should call:
 *   curl -s -X POST http://localhost:<port>/api/daemon/restart
 * instead of calling launchctl directly.
 *
 * RESTART-LOOP GUARD (todo #852, fast-follow to #436/#98):
 *   Defense-in-depth against a wedged or looping worker hammering this
 *   endpoint. After RESTART_LOOP_MAX_COUNT successful accepts within a
 *   RESTART_LOOP_WINDOW_MS sliding window, further requests are refused
 *   with 429 and a warning is logged. The endpoint deliberately has no
 *   authentication (workers are legitimate callers); this guard is the
 *   rate-limiting layer.
 */

import type http from 'node:http';
import { createLogger } from '../core/logger.js';
import { json, withTimestamp } from './helpers.js';

const logger = createLogger('restart');

// ── Deferred-restart constants ────────────────────────────────

/** Grace period between the 202 response and the actual shutdown call (ms). */
export const DEFERRED_RESTART_DELAY_MS = 2000;

// ── Restart-loop guard constants ──────────────────────────────

/**
 * Maximum number of restart requests accepted within a RESTART_LOOP_WINDOW_MS
 * sliding window. The (RESTART_LOOP_MAX_COUNT+1)th request in-window is
 * refused with 429.
 *
 * Default: 5 per minute. Configurable at construction time via env
 * KITHKIT_RESTART_LOOP_MAX (parsed at module load, useful for integration
 * tests; prefer the _setNowFn seam for unit tests).
 */
export const RESTART_LOOP_MAX_COUNT: number = (() => {
  const v = Number(process.env['KITHKIT_RESTART_LOOP_MAX']);
  return Number.isFinite(v) && v > 0 ? v : 5;
})();

/**
 * Sliding-window duration in milliseconds for the restart-loop guard.
 * Timestamps older than this are evicted from the window.
 */
export const RESTART_LOOP_WINDOW_MS = 60_000;

// ── Injectable shutdown function (for testing) ───────────────

type ShutdownFn = (reason: string) => Promise<void>;

let _shutdownFn: ShutdownFn | null = null;

/**
 * Inject the daemon's shutdown function.
 * Called from main.ts after `shutdown` is defined.
 * In tests, inject a spy to verify call timing without actually exiting.
 */
export function setShutdownFn(fn: ShutdownFn | null): void {
  _shutdownFn = fn;
}

/** @internal For tests to inspect / await the pending timer. */
let _pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * @internal Expose the pending timer handle for test assertions.
 * Returns null if no restart is pending.
 */
export function _getPendingRestartTimer(): ReturnType<typeof setTimeout> | null {
  return _pendingRestartTimer;
}

// ── Restart-loop guard state ──────────────────────────────────

/** Timestamps of recent accepted restart requests within the current window. */
let _restartTimestamps: number[] = [];

/**
 * Clock seam — injectable for deterministic time control in tests.
 * Production code uses Date.now; tests inject a fake clock.
 */
let _nowFn: () => number = Date.now;

/**
 * @internal Inject a clock function for deterministic testing.
 * Allows tests to control the "current time" without real wall-clock sleeps.
 */
export function _setNowFn(fn: () => number): void {
  _nowFn = fn;
}

/**
 * Warn-sink type used by the restart-loop guard when it refuses a request.
 * Receives a human-readable message plus structured fields.
 */
type WarnFn = (msg: string, data: { count: number; window_ms: number }) => void;

const _defaultWarnFn: WarnFn = (msg, data) => logger.warn(msg, data);
let _warnFn: WarnFn = _defaultWarnFn;

/**
 * @internal Inject a warn sink for test observation of guard log events.
 * Pass null to restore the default (structured logger) sink.
 */
export function _setWarnFn(fn: WarnFn | null): void {
  _warnFn = fn ?? _defaultWarnFn;
}

/** @internal Reset module state between tests. */
export function _resetRestartForTesting(): void {
  if (_pendingRestartTimer !== null) {
    clearTimeout(_pendingRestartTimer);
    _pendingRestartTimer = null;
  }
  _shutdownFn = null;
  _restartTimestamps = [];
  _nowFn = Date.now;
  _warnFn = _defaultWarnFn;
}

// ── Route handler ────────────────────────────────────────────

export async function handleRestartRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // POST /api/daemon/restart
  if (pathname === '/api/daemon/restart' && method === 'POST') {
    // ── Restart-loop guard (defense-in-depth, todo #852) ─────
    // Slide the window: evict timestamps older than RESTART_LOOP_WINDOW_MS.
    const now = _nowFn();
    _restartTimestamps = _restartTimestamps.filter((t) => now - t < RESTART_LOOP_WINDOW_MS);

    if (_restartTimestamps.length >= RESTART_LOOP_MAX_COUNT) {
      // (N+1)th restart in-window: refuse and log.
      const count = _restartTimestamps.length;
      _warnFn(
        `restart-loop guard: refusing restart — ${count} restarts in ${RESTART_LOOP_WINDOW_MS}ms window (max ${RESTART_LOOP_MAX_COUNT})`,
        { count, window_ms: RESTART_LOOP_WINDOW_MS },
      );
      const retryAfterSeconds = Math.ceil(
        (_restartTimestamps[0]! + RESTART_LOOP_WINDOW_MS - now) / 1000,
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      json(res, 429, withTimestamp({
        error: 'Restart rate limit exceeded',
        detail: `Maximum ${RESTART_LOOP_MAX_COUNT} restarts allowed per ${RESTART_LOOP_WINDOW_MS / 1000}s window`,
        retry_after_seconds: retryAfterSeconds,
      }));
      return true;
    }

    // Record this restart in the window before responding.
    _restartTimestamps.push(now);

    // ─────────────────────────────────────────────────────────
    // Respond 202 BEFORE scheduling the shutdown.
    // This is the core of the fix: the calling worker receives its response
    // and can exit cleanly before the daemon goes down.
    json(res, 202, withTimestamp({
      message: 'Daemon restart scheduled',
      delay_ms: DEFERRED_RESTART_DELAY_MS,
    }));

    // Guard: only one pending restart at a time
    if (_pendingRestartTimer !== null) {
      // Already scheduled — don't stack multiple exits
      return true;
    }

    // Defer the actual shutdown — this is what prevents the worker orphan bug.
    // With the fix: shutdown is called ~2s after the 202 is sent.
    // Without the fix (mutation): shutdown would be called synchronously here,
    // before the worker receives the 202, killing it mid-flight.
    _pendingRestartTimer = setTimeout(() => {
      _pendingRestartTimer = null;
      const fn = _shutdownFn;
      if (fn) {
        fn('deferred-restart').catch(() => process.exit(1));
      } else {
        process.exit(0);
      }
    }, DEFERRED_RESTART_DELAY_MS);

    return true;
  }

  return false;
}
