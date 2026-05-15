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
 */

import { createLogger } from '../../core/logger.js';
import { loadConfig } from '../../core/config.js';
import type { Scheduler } from '../scheduler.js';
import { getLastActivityTimestamp } from './helpers/activity-query.js';
import { fireSelfWatchdogAlert } from './helpers/alert.js';

const log = createLogger('self-watchdog');

const DEFAULT_WARN_SECONDS = 6 * 3600;   // 6 hours
const DEFAULT_ALERT_SECONDS = 12 * 3600; // 12 hours

async function run(): Promise<void> {
  const config = loadConfig();
  const watchdog = config.daemon.self_watchdog;

  if (watchdog?.enabled === false) {
    log.debug('Self-watchdog disabled via config');
    return;
  }

  const warnSeconds = watchdog?.idle_threshold_seconds?.warn_seconds ?? DEFAULT_WARN_SECONDS;
  const alertSeconds = watchdog?.idle_threshold_seconds?.alert_seconds ?? DEFAULT_ALERT_SECONDS;

  const lastActivityAt = await getLastActivityTimestamp();
  const nowMs = Date.now();

  // If no activity ever recorded, treat as maximally idle
  const idleMs = lastActivityAt !== null ? nowMs - lastActivityAt : Infinity;
  const idleSeconds = idleMs === Infinity ? Infinity : idleMs / 1000;

  log.debug('Self-watchdog tick', {
    lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : 'never',
    idleSeconds: idleSeconds === Infinity ? 'infinity' : Math.round(idleSeconds),
    warnSeconds,
    alertSeconds,
  });

  if (idleSeconds >= alertSeconds) {
    log.warn('Daemon zombie detected — alert threshold exceeded', {
      idleSeconds: idleSeconds === Infinity ? 'infinity' : Math.round(idleSeconds),
      alertSeconds,
    });
    await fireSelfWatchdogAlert('alert', {
      idleSeconds: idleSeconds === Infinity ? alertSeconds : idleSeconds,
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
