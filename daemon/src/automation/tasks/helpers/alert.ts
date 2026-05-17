/**
 * Self-Watchdog Alert — three-channel alert fanout with dedup.
 *
 * Fires alerts via:
 *   1. Telegram — POST /api/send (routes through the daemon's own HTTP server)
 *   2. Tmux     — inject into the comms session (dynamic import, degrades gracefully)
 *   3. A2A      — POST /api/a2a/send (routes through the daemon's own HTTP server)
 *
 * Channel survivability: Telegram and A2A both route through the daemon's own HTTP
 * API (`http://127.0.0.1:{port}/api/send` and `/api/a2a/send`). They share the same
 * failure domain as the daemon being watched — if the HTTP listener hangs, both fail
 * silently in their try/catch blocks. Only the tmux injectMessage path is truly
 * out-of-band. This fanout is designed for the zombie scenario where the HTTP listener
 * is still alive but no real work is being processed.
 *
 * Dedup state is persisted in feature_state so it survives daemon restarts.
 * The dedup window prevents re-firing the same alert level within N seconds
 * (default 1 hour, configurable via daemon.self_watchdog.dedup_window_seconds).
 */

import { query, exec } from '../../../core/db.js';
import { loadConfig } from '../../../core/config.js';
import { createLogger } from '../../../core/logger.js';

const log = createLogger('self-watchdog:alert');

const FEATURE_STATE_KEY = 'self-watchdog:last-alert';

// ── Dedup state ──────────────────────────────────────────────

interface AlertDedupState {
  last_warn_at: number | null;
  last_alert_at: number | null;
}

function readDedupState(): AlertDedupState {
  try {
    const rows = query<{ state: string }>(
      'SELECT state FROM feature_state WHERE feature = ?',
      FEATURE_STATE_KEY,
    );
    if (rows[0]?.state) {
      return JSON.parse(rows[0].state) as AlertDedupState;
    }
  } catch {
    // First run or table unavailable — start fresh
  }
  return { last_warn_at: null, last_alert_at: null };
}

function writeDedupState(state: AlertDedupState): void {
  try {
    exec(
      `INSERT INTO feature_state (feature, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(feature) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      FEATURE_STATE_KEY,
      JSON.stringify(state),
      new Date().toISOString(),
    );
  } catch (err) {
    log.warn('Failed to persist dedup state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Alert message ────────────────────────────────────────────

function buildMessage(
  level: 'warn' | 'alert',
  context: { idleSeconds: number; lastActivityAt: number | null },
): string {
  const idleHours = (context.idleSeconds / 3600).toFixed(1);
  const lastStr = context.lastActivityAt
    ? new Date(context.lastActivityAt).toISOString()
    : 'never';

  const prefix = level === 'warn'
    ? '[self-watchdog WARN]'
    : '[self-watchdog ALERT]';

  return (
    `${prefix} Daemon has been idle for ${idleHours}h — no real work detected ` +
    `(worker_jobs, orchestrator_tasks, messages, memories, todos). ` +
    `Last real-work timestamp: ${lastStr}. ` +
    `Check orchestrator and worker health.`
  );
}

// ── Three-channel fanout ─────────────────────────────────────

async function sendViaTelegram(message: string, port: number): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message, channels: ['telegram'] }),
  });
  if (!resp.ok) {
    throw new Error(`/api/send returned ${resp.status}`);
  }
}

async function sendViaTmux(message: string): Promise<void> {
  // Dynamic import — tmux module may fail if tmux is not running
  const { injectMessage } = await import('../../../agents/tmux.js');
  injectMessage('comms', message);
}

async function sendViaA2A(message: string, port: number, group: string): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${port}/api/a2a/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      group,
      payload: {
        type: 'status',
        text: message,
      },
    }),
  });
  if (!resp.ok) {
    throw new Error(`/api/a2a/send returned ${resp.status}`);
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Fire a self-watchdog alert across all configured channels.
 * Suppresses the alert if the same level fired within the dedup window.
 */
export async function fireSelfWatchdogAlert(
  level: 'warn' | 'alert',
  context: { idleSeconds: number; lastActivityAt: number | null },
): Promise<void> {
  const config = loadConfig();
  const dedupWindowMs = (config.daemon.self_watchdog?.dedup_window_seconds ?? 3600) * 1000;

  const now = Date.now();
  const state = readDedupState();

  // Dedup: don't re-fire the same level within the window
  const lastFiredAt = level === 'warn' ? state.last_warn_at : state.last_alert_at;
  if (lastFiredAt !== null && now - lastFiredAt < dedupWindowMs) {
    log.debug('Alert suppressed by dedup window', {
      level,
      lastFiredAt: new Date(lastFiredAt).toISOString(),
      dedupWindowMs,
    });
    return;
  }

  const message = buildMessage(level, context);
  const port = config.daemon.port;

  log.info('Firing self-watchdog alert', {
    level,
    idleSeconds: Math.round(context.idleSeconds),
    lastActivityAt: context.lastActivityAt ? new Date(context.lastActivityAt).toISOString() : 'never',
  });

  // Channel 1: Telegram
  try {
    await sendViaTelegram(message, port);
    log.info('Alert sent via telegram', { level });
  } catch (err) {
    log.warn('Failed to send alert via telegram', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Channel 2: Tmux (comms session)
  try {
    await sendViaTmux(message);
    log.info('Alert injected to comms tmux session', { level });
  } catch (err) {
    log.debug('Tmux inject skipped or failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Channel 3: A2A (configured group, optional)
  const a2aGroup = config.daemon.self_watchdog?.a2a_group;
  if (a2aGroup) {
    try {
      await sendViaA2A(message, port, a2aGroup);
      log.info('Alert sent via A2A', { level, group: a2aGroup });
    } catch (err) {
      log.debug('A2A send skipped or failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.debug('A2A group not configured, skipping A2A channel');
  }

  // Persist dedup state
  const updated: AlertDedupState = { ...state };
  if (level === 'warn') {
    updated.last_warn_at = now;
  } else {
    updated.last_alert_at = now;
  }
  writeDedupState(updated);
}
