/**
 * Extended Status — aggregated ops data and detailed health checks.
 *
 * Provides /status/extended and /health/extended endpoints with
 * a service check registry for extensions to add custom checks.
 */

import { createLogger } from './logger.js';
import { getHealth } from './health.js';
import { getDatabase } from './db.js';

const log = createLogger('extended-status');

// ── Types ───────────────────────────────────────────────────

export interface CheckResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export type HealthCheckFn = () => Promise<CheckResult> | CheckResult;

export interface ExtendedHealth {
  status: 'ok' | 'degraded';
  uptime: number;
  version: string;
  timestamp: string;
  checks: Record<string, CheckResult>;
}

export interface ExtendedStatus {
  daemon: {
    uptime: number;
    version: string;
    pid: number;
    memoryMB: number;
  };
  db: {
    ok: boolean;
    tables: number;
    todoCount: number;
    memoryCount: number;
  };
  scheduler: {
    taskCount: number;
    recentResults: Array<{
      task: string;
      status: string;
      durationMs: number;
      ranAt: string;
    }>;
  };
  checks: Record<string, CheckResult>;
  timestamp: string;
}

// ── DB Row Types ────────────────────────────────────────────

/** Result of SELECT count(*) queries. */
interface CountRow {
  cnt: number;
}

/** Row shape from task_results queries. */
interface TaskResultRow {
  task_name: string;
  status: string;
  duration_ms: number;
  created_at: string;
}

// ── Check Registry ──────────────────────────────────────────

const _checks = new Map<string, HealthCheckFn>();

/**
 * Register a health check function.
 * Called by extensions during init to add custom checks.
 */
export function registerCheck(name: string, checkFn: HealthCheckFn): void {
  if (_checks.has(name)) {
    log.warn(`Overwriting existing health check: ${name}`);
  }
  _checks.set(name, checkFn);
  log.debug(`Registered health check: ${name}`);
}

/**
 * Get all registered check names.
 */
export function getRegisteredChecks(): string[] {
  return [..._checks.keys()];
}

// ── Base Checks ─────────────────────────────────────────────

async function runDaemonCheck(): Promise<CheckResult> {
  return {
    ok: true,
    message: 'Daemon running',
    details: {
      uptime: process.uptime(),
      pid: process.pid,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  };
}

async function runDbCheck(): Promise<CheckResult> {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT count(*) as cnt FROM sqlite_master WHERE type=\'table\'').get() as CountRow | undefined;
    return {
      ok: true,
      message: `Database OK (${row?.cnt ?? 0} tables)`,
      details: { tables: row?.cnt ?? 0 },
    };
  } catch (err) {
    return {
      ok: false,
      message: `Database error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Extended Health ─────────────────────────────────────────

/**
 * Run all health checks and return extended health data.
 */
export async function getExtendedHealth(version: string): Promise<ExtendedHealth> {
  const base = getHealth(version);
  const checks: Record<string, CheckResult> = {};

  // Run base checks
  checks['daemon'] = await runDaemonCheck();
  checks['database'] = await runDbCheck();

  // Run registered checks
  for (const [name, checkFn] of _checks) {
    try {
      checks[name] = await checkFn();
    } catch (err) {
      checks[name] = {
        ok: false,
        message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const allOk = Object.values(checks).every(c => c.ok);

  return {
    status: allOk ? 'ok' : 'degraded',
    uptime: base.uptime,
    version: base.version,
    timestamp: base.timestamp,
    checks,
  };
}

/**
 * Format extended health as plain text.
 */
export function formatHealthText(health: ExtendedHealth): string {
  const lines: string[] = [
    `Status: ${health.status.toUpperCase()}`,
    `Uptime: ${health.uptime}s`,
    `Version: ${health.version}`,
    '',
    'Checks:',
  ];

  for (const [name, check] of Object.entries(health.checks)) {
    const icon = check.ok ? '[OK]' : '[FAIL]';
    lines.push(`  ${icon} ${name}: ${check.message ?? (check.ok ? 'Passing' : 'Failing')}`);
  }

  lines.push('', `Timestamp: ${health.timestamp}`);
  return lines.join('\n');
}

// ── Extended Status ─────────────────────────────────────────

/**
 * Get aggregated operational status.
 */
export async function getExtendedStatus(version: string): Promise<ExtendedStatus> {
  const health = await getExtendedHealth(version);

  // DB stats
  let todoCount = 0;
  let memoryCount = 0;
  let tableCount = 0;
  let dbOk = false;
  try {
    const db = getDatabase();
    const tables = db.prepare('SELECT count(*) as cnt FROM sqlite_master WHERE type=\'table\'').get() as CountRow | undefined;
    tableCount = tables?.cnt ?? 0;
    try {
      const todos = db.prepare('SELECT count(*) as cnt FROM todos').get() as CountRow | undefined;
      todoCount = todos?.cnt ?? 0;
    } catch { /* table may not exist */ }
    try {
      const memories = db.prepare('SELECT count(*) as cnt FROM memories').get() as CountRow | undefined;
      memoryCount = memories?.cnt ?? 0;
    } catch { /* table may not exist */ }
    dbOk = true;
  } catch { /* db not available */ }

  // Recent scheduler results
  let recentResults: ExtendedStatus['scheduler']['recentResults'] = [];
  try {
    const db = getDatabase();
    const rows = db.prepare(
      'SELECT task_name, status, duration_ms, created_at FROM task_results ORDER BY created_at DESC LIMIT 10'
    ).all() as TaskResultRow[];
    recentResults = rows.map(r => ({
      task: r.task_name,
      status: r.status,
      durationMs: r.duration_ms,
      ranAt: r.created_at,
    }));
  } catch { /* table may not exist */ }

  return {
    daemon: {
      uptime: Math.floor(process.uptime()),
      version,
      pid: process.pid,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    db: {
      ok: dbOk,
      tables: tableCount,
      todoCount,
      memoryCount,
    },
    scheduler: {
      taskCount: recentResults.length,
      recentResults,
    },
    checks: health.checks,
    timestamp: new Date().toISOString(),
  };
}

// ── Testing ─────────────────────────────────────────────────

/** Reset all state for testing. */
export function _resetForTesting(): void {
  _checks.clear();
}
