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
 */

import type http from 'node:http';
import { json, withTimestamp } from './helpers.js';

// ── Constants ────────────────────────────────────────────────

/** Grace period between the 202 response and the actual shutdown call (ms). */
export const DEFERRED_RESTART_DELAY_MS = 2000;

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

/** @internal Reset module state between tests. */
export function _resetRestartForTesting(): void {
  if (_pendingRestartTimer !== null) {
    clearTimeout(_pendingRestartTimer);
    _pendingRestartTimer = null;
  }
  _shutdownFn = null;
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
