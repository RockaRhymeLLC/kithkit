/**
 * Self-Watchdog — detects zombie daemon state.
 *
 * Runs on a configurable interval (default 5 minutes). Computes a composite
 * "real work" timestamp from five activity tables and compares it to the
 * current time. If the daemon has been alive (scheduler ticking) but no
 * real work has happened for a long time, fires a tiered alert.
 *
 * This guards against bugs like the orchestrator-idle-shutdown regression
 * (#106) where the daemon continued running but silently stopped processing.
 *
 * Thresholds (configurable via daemon.self_watchdog.idle_threshold_seconds):
 *   warn_seconds  — 6 hours by default
 *   alert_seconds — 12 hours by default
 *
 * Alert channels: telegram, tmux (comms session), A2A (configured group, optional).
 * Dedup window: 1 hour by default (daemon.self_watchdog.dedup_window_seconds).
 *
 * Channel survivability note: Telegram delivery delegates to alert.ts
 * sendViaTelegram → routeMessage() in-process (no HTTP hop, not gated by the
 * /api/send auth gate — see alert.ts:4-13). A2A delivery routes through
 * POST /api/a2a/send on the daemon's own HTTP server. A2A shares the HTTP
 * listener as its failure domain — if the listener hangs or crashes, it fails
 * silently in its try/catch. Only the tmux injectMessage path is truly
 * out-of-band. The three-channel fanout is designed for the motivating zombie
 * scenario where the scheduler is ticking and the HTTP listener is alive but no
 * real work is being processed.
 */

import { createLogger } from '../../core/logger.js';
import { loadConfig } from '../../core/config.js';
import type { Scheduler } from '../scheduler.js';
import { getLastActivityTimestamp } from './helpers/activity-query.js';
import { fireSelfWatchdogAlert as _fireSelfWatchdogAlert } from './helpers/alert.js';
import { checkDistStaleness } from './dist-staleness.js';

const log = createLogger('self-watchdog');

const DEFAULT_WARN_SECONDS = 6 * 3600;   // 6 hours
const DEFAULT_ALERT_SECONDS = 12 * 3600; // 12 hours

// ── Injectable deps (overridable for testing) ────────────────

let fireSelfWatchdogAlert = _fireSelfWatchdogAlert;

async function run(): Promise<void> {
  const config = loadConfig();
  const watchdog = config.daemon.self_watchdog;

  if (watchdog?.enabled === false) {
    log.debug('Self-watchdog disabled via config');
    return;
  }

  const warnSeconds = watchdog?.idle_threshold_seconds?.warn_seconds ?? DEFAULT_WARN_SECONDS;
  const alertSeconds = watchdog?.idle_threshold_seconds?.alert_seconds ?? DEFAULT_ALERT_SECONDS;

  // Dist-staleness check — runs on every tick, independent of idle/zombie state.
  await checkDistStaleness();

  const lastActivityAt = await getLastActivityTimestamp();

  // If no activity has ever been recorded (fresh install, DB wipe, daemon first boot),
  // there is no evidence of a zombie — skip this tick rather than treating absence of
  // data as maximum idleness. The watchdog will detect real zombie state once at least
  // one activity record exists.
  if (lastActivityAt === null) {
    log.debug('Self-watchdog: no activity recorded yet — skipping (fresh install or DB wipe)');
    return;
  }

  const nowMs = Date.now();
  const idleMs = nowMs - lastActivityAt;
  const idleSeconds = idleMs / 1000;

  log.debug('Self-watchdog tick', {
    lastActivityAt: new Date(lastActivityAt).toISOString(),
    idleSeconds: Math.round(idleSeconds),
    warnSeconds,
    alertSeconds,
  });

  if (idleSeconds >= alertSeconds) {
    log.warn('Daemon zombie detected — alert threshold exceeded', {
      idleSeconds: Math.round(idleSeconds),
      alertSeconds,
    });
    await fireSelfWatchdogAlert('alert', {
      idleSeconds,
      lastActivityAt,
    });
  } else if (idleSeconds >= warnSeconds) {
    log.warn('Daemon idle — warn threshold exceeded', {
      idleSeconds: Math.round(idleSeconds),
      warnSeconds,
    });
    await fireSelfWatchdogAlert('warn', {
      idleSeconds,
      lastActivityAt,
    });
  }
}

/**
 * Register the self-watchdog task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('self-watchdog', async () => {
    await run();
  });
}

// ── Testing ──────────────────────────────────────────────────

/** @internal Expose run() for direct testing. */
export async function _runForTesting(): Promise<void> {
  return run();
}

/** @internal Override injectable deps for testing. Pass null to restore originals. */
export function _setDepsForTesting(deps: {
  fireSelfWatchdogAlert?: typeof _fireSelfWatchdogAlert;
} | null): void {
  if (deps === null) {
    fireSelfWatchdogAlert = _fireSelfWatchdogAlert;
    return;
  }
  if (deps.fireSelfWatchdogAlert) fireSelfWatchdogAlert = deps.fireSelfWatchdogAlert;
}
