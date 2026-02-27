/**
 * Timer API — schedule delayed self-pokes injected into tmux sessions.
 *
 * Alarm clock behavior: fires once, then nags every 30s until acknowledged.
 * Auto-expires after 10 minutes of nagging.
 *
 * Routes:
 *   POST   /api/timer             — Schedule a delayed tmux injection
 *   GET    /api/timers            — List all timers (active + recently completed)
 *   DELETE /api/timer/:id         — Cancel a timer
 *   POST   /api/timer/:id/ack     — Acknowledge a fired timer (stops nagging)
 *   POST   /api/timer/:id/snooze  — Snooze a fired timer (reschedule)
 */

import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { json, withTimestamp, parseBody } from './helpers.js';
import { injectMessage } from '../agents/tmux.js';
import { createLogger } from '../core/logger.js';
import { insert, update, query } from '../core/db.js';

const log = createLogger('timer-api');

// ── Session resolution ───────────────────────────────────────

/**
 * Normalize agent ID to a known persistent agent.
 * Accepts 'comms' or 'orchestrator'; defaults to 'comms'.
 * Returns the agent ID (NOT the tmux session name) so that
 * injectMessage() can resolve it via its own resolveSession().
 */
function normalizeAgentId(agent: string): string {
  if (agent === 'orchestrator') return 'orchestrator';
  return 'comms';
}

// ── Constants ────────────────────────────────────────────────

const NAG_INTERVAL_MS = 30_000;      // 30 seconds between nags
const MAX_NAG_DURATION_MS = 600_000; // 10 minutes before auto-expire
const DEFAULT_SNOOZE_S = 300;        // 5 minutes default snooze

// ── Timer state ──────────────────────────────────────────────

type TimerStatus = 'pending' | 'fired' | 'acknowledged' | 'snoozed' | 'expired' | 'cancelled';

interface TimerEntry {
  id: string;
  session: string;
  message: string;
  fires_at: string;
  created_at: string;
  status: TimerStatus;
  fired_at?: string;
  completed_at?: string;
  handle: ReturnType<typeof setTimeout>;
  nagHandle?: ReturnType<typeof setInterval>;
}

interface DbTimerRow {
  id: string;
  session: string;
  message: string;
  fires_at: string;
  created_at: string;
  status: string;
  fired_at: string | null;
  completed_at: string | null;
}

const timers = new Map<string, TimerEntry>();

// ── Helpers ──────────────────────────────────────────────────

/** Parse delay from seconds (number) or string with unit (e.g. "2m", "90s"). */
function parseDelay(raw: unknown): number | null {
  if (typeof raw === 'number') return raw >= 0 ? raw : null;
  if (typeof raw === 'string') {
    const m = raw.match(/^(\d+(?:\.\d+)?)(s|m)$/i);
    if (!m) return null;
    const val = parseFloat(m[1]);
    return m[2].toLowerCase() === 'm' ? val * 60 : val;
  }
  return null;
}

/** Stop and clear all handles for a timer entry. */
function clearHandles(entry: TimerEntry): void {
  clearTimeout(entry.handle);
  if (entry.nagHandle !== undefined) {
    clearInterval(entry.nagHandle);
    entry.nagHandle = undefined;
  }
}

/** Persist current timer state to the database. */
function updateTimerDb(entry: TimerEntry): void {
  update('timers', entry.id, {
    status: entry.status,
    fires_at: entry.fires_at,
    fired_at: entry.fired_at ?? null,
    completed_at: entry.completed_at ?? null,
  });
}

/** Mark a timer as completed with the given status. */
function complete(entry: TimerEntry, status: TimerStatus): void {
  clearHandles(entry);
  entry.status = status;
  entry.completed_at = new Date().toISOString();
  updateTimerDb(entry);
  log.info('Timer completed', { id: entry.id, status });
}

/** Start the nag cycle for a fired timer. `firedAt` is the epoch ms when it first fired. */
function startNagCycle(entry: TimerEntry, firedAt: number): void {
  entry.nagHandle = setInterval(() => {
    const elapsed = Math.floor((Date.now() - firedAt) / 1000);

    if (elapsed >= MAX_NAG_DURATION_MS / 1000) {
      complete(entry, 'expired');
      injectMessage(entry.session, `[timer] ${entry.message} (expired — unacknowledged for 10 minutes)`);
      return;
    }

    const nagText = `[timer] ${entry.message} (${elapsed}s ago, unacknowledged)`;
    const nagOk = injectMessage(entry.session, nagText);
    if (!nagOk) {
      log.warn('Nag injection failed', { id: entry.id, elapsed });
    } else {
      log.info('Timer nag sent', { id: entry.id, elapsed });
    }
  }, NAG_INTERVAL_MS);
}

/** Fire the timer: inject first message and start the nag cycle. */
function fireTimer(entry: TimerEntry): void {
  entry.status = 'fired';
  entry.fired_at = new Date().toISOString();
  updateTimerDb(entry);

  // Initial fire
  const ok = injectMessage(entry.session, `[timer] ${entry.message}`);
  if (!ok) {
    log.warn('Timer fired but injection failed', { id: entry.id, session: entry.session });
  } else {
    log.info('Timer fired', { id: entry.id, message: entry.message });
  }

  startNagCycle(entry, Date.now());
}

// ── Startup reload ────────────────────────────────────────────

/**
 * Reload active timers from the database on daemon startup.
 * Re-schedules pending/snoozed timers and restarts nag cycles for fired ones.
 */
export function initTimers(): void {
  const rows = query<DbTimerRow>(
    `SELECT * FROM timers WHERE status IN ('pending', 'snoozed', 'fired')`,
  );

  if (rows.length === 0) return;

  for (const row of rows) {
    const entry: TimerEntry = {
      id: row.id,
      session: row.session,
      message: row.message,
      fires_at: row.fires_at,
      created_at: row.created_at,
      status: row.status as TimerStatus,
      fired_at: row.fired_at ?? undefined,
      completed_at: row.completed_at ?? undefined,
      handle: setTimeout(() => {}, 0), // placeholder — replaced below for pending/snoozed
    };
    timers.set(entry.id, entry);

    if (row.status === 'fired') {
      // Restart nag cycle — don't re-fire, just resume nagging
      const firedAt = row.fired_at ? new Date(row.fired_at).getTime() : Date.now();
      const elapsed = Date.now() - firedAt;

      if (elapsed >= MAX_NAG_DURATION_MS) {
        // Expired while daemon was down — mark it now
        complete(entry, 'expired');
        log.info('Timer expired during restart', { id: entry.id });
      } else {
        startNagCycle(entry, firedAt);
        log.info('Timer nag cycle resumed', { id: entry.id });
      }
    } else {
      // pending or snoozed — re-schedule
      const remainingMs = Math.max(0, new Date(row.fires_at).getTime() - Date.now());
      entry.handle = setTimeout(() => fireTimer(entry), remainingMs);
      log.info('Timer reloaded', { id: entry.id, remainingMs });
    }
  }

  log.info('Timers reloaded from DB', { count: rows.length });
}

// ── Route handler ────────────────────────────────────────────

export async function handleTimerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // POST /api/timer — schedule a new timer
  if (pathname === '/api/timer' && method === 'POST') {
    const body = await parseBody(req);

    const delay = parseDelay(body.delay);
    if (delay === null) {
      json(res, 400, withTimestamp({
        error: 'delay is required — number (seconds) or string with unit (e.g. "2m", "90s")',
      }));
      return true;
    }

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      json(res, 400, withTimestamp({ error: 'message is required' }));
      return true;
    }

    const agentId = typeof body.agent === 'string' ? body.agent.trim() : 'comms';
    const session = normalizeAgentId(agentId);
    const id = randomUUID();
    const fires_at = new Date(Date.now() + delay * 1000).toISOString();
    const created_at = new Date().toISOString();

    const handle = setTimeout(() => fireTimer(entry), delay * 1000);

    const entry: TimerEntry = {
      id, session, message, fires_at, created_at,
      status: 'pending',
      handle,
    };
    timers.set(id, entry);

    insert('timers', { id, session, message, fires_at, created_at, status: 'pending' });

    log.info('Timer scheduled', { id, session, delay, fires_at });
    json(res, 201, withTimestamp({ id, fires_at, message, status: 'pending' }));
    return true;
  }

  // GET /api/timers — list all timers
  if (pathname === '/api/timers' && method === 'GET') {
    const list = [...timers.values()].map(({ id, session, message, fires_at, created_at, status, fired_at, completed_at }) => ({
      id, session, message, fires_at, created_at, status, fired_at, completed_at,
    }));
    json(res, 200, withTimestamp({ timers: list, count: list.length }));
    return true;
  }

  // Routes with /:id suffix
  const idMatch = pathname.match(/^\/api\/timer\/([^/]+)(\/[^/]+)?$/);
  if (!idMatch) return false;

  const id = idMatch[1];
  const subpath = idMatch[2] ?? '';

  // DELETE /api/timer/:id — cancel a timer
  if (!subpath && method === 'DELETE') {
    const entry = timers.get(id);
    if (!entry) {
      json(res, 404, withTimestamp({ error: 'Timer not found' }));
      return true;
    }
    complete(entry, 'cancelled');
    timers.delete(id);
    log.info('Timer cancelled', { id });
    json(res, 200, withTimestamp({ id, cancelled: true }));
    return true;
  }

  // POST /api/timer/:id/ack — acknowledge a fired timer
  if (subpath === '/ack' && method === 'POST') {
    const entry = timers.get(id);
    if (!entry) {
      json(res, 404, withTimestamp({ error: 'Timer not found' }));
      return true;
    }
    if (entry.status !== 'fired') {
      json(res, 409, withTimestamp({ error: `Timer is ${entry.status}, not fired` }));
      return true;
    }
    complete(entry, 'acknowledged');
    log.info('Timer acknowledged', { id });
    json(res, 200, withTimestamp({ id, acknowledged: true }));
    return true;
  }

  // POST /api/timer/:id/snooze — snooze a fired timer
  if (subpath === '/snooze' && method === 'POST') {
    const entry = timers.get(id);
    if (!entry) {
      json(res, 404, withTimestamp({ error: 'Timer not found' }));
      return true;
    }
    if (entry.status !== 'fired') {
      json(res, 409, withTimestamp({ error: `Timer is ${entry.status}, not fired` }));
      return true;
    }

    const body = await parseBody(req);
    const snoozeDelay = parseDelay(body.delay) ?? DEFAULT_SNOOZE_S;

    // Stop current nag cycle
    clearHandles(entry);
    entry.status = 'snoozed';
    entry.fires_at = new Date(Date.now() + snoozeDelay * 1000).toISOString();
    entry.fired_at = undefined;
    updateTimerDb(entry);

    // Reschedule
    entry.handle = setTimeout(() => fireTimer(entry), snoozeDelay * 1000);

    log.info('Timer snoozed', { id, snoozeDelay, fires_at: entry.fires_at });
    json(res, 200, withTimestamp({ id, snoozed: true, fires_at: entry.fires_at }));
    return true;
  }

  return false;
}
