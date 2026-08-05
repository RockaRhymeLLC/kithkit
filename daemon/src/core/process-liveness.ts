/**
 * Real OS-process liveness checks, shared by:
 *  - agents/lifecycle.ts (records this daemon process's own pid/start-time as
 *    the "owner" of a worker_jobs row at spawn time)
 *  - core/orphan-cleanup.ts (checks whether a recorded owner is still alive
 *    before claiming a stuck worker_jobs row)
 *
 * A liveness check alone is not enough: PIDs are reused by the OS, so a dead
 * owner's PID can be reassigned to an unrelated live process before the next
 * cleanup sweep runs, producing a false "still alive". Recording the owning
 * process's start time (`ps -o lstart=`) and re-checking it alongside the PID
 * defeats that reuse case.
 */

import { execFileSync } from 'node:child_process';

/**
 * Return the start time of the given pid as reported by `ps -o lstart=`, or
 * null if the process doesn't exist or `ps` fails for any reason. Portable
 * across macOS (BSD ps) and Linux (procps) — both support `-o lstart=`.
 */
export function getProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Whether a process with the given pid currently exists. Uses the
 * zero-signal `kill(pid, 0)` probe — no signal is actually delivered.
 * EPERM means the process exists but we lack permission to signal it (still
 * alive); ESRCH (or any other failure) means it does not.
 */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * Whether the process that owns a resource is still the same live process
 * that originally claimed it.
 *
 * - pid doesn't exist              -> false (definitely gone)
 * - pid exists, no baseline to compare (`expectedStartedAt` null/unknown)
 *   -> true (trust raw liveness; we have nothing to detect reuse with)
 * - pid exists, baseline known, current start time unreadable
 *   -> true (don't punish an unrelated `ps` failure by false-orphaning a
 *      live pid)
 * - pid exists, baseline known, start times differ
 *   -> false (PID was recycled by a different process)
 */
export function isProcessAlive(pid: number, expectedStartedAt: string | null): boolean {
  if (!pidExists(pid)) return false;
  if (!expectedStartedAt) return true;
  const currentStartedAt = getProcessStartTime(pid);
  if (!currentStartedAt) return true;
  return currentStartedAt === expectedStartedAt;
}

// ── Self identity (memoized — computed once per daemon process) ──────────

let selfIdentity: { pid: number; startedAt: string | null } | null = null;

/**
 * This daemon process's own pid and start time, computed once and cached.
 * Used to stamp new worker_jobs rows with their owning process's identity.
 */
export function getSelfProcessIdentity(): { pid: number; startedAt: string | null } {
  if (!selfIdentity) {
    selfIdentity = { pid: process.pid, startedAt: getProcessStartTime(process.pid) };
  }
  return selfIdentity;
}

/** @internal Reset the memoized self identity — testing only. */
export function _resetSelfProcessIdentityForTesting(): void {
  selfIdentity = null;
}
