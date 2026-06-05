/**
 * Saturday Night Status Report — weekly summary delivered every Saturday at 8pm.
 *
 * Gathers a full week's worth of activity across todos, orchestrator tasks,
 * git commits, token/cost usage, and open carryover items, then delivers
 * a Telegram-friendly HTML message via the daemon send API.
 *
 * Each section is independently try/caught so a single failing data source
 * does not block the rest of the report.
 *
 * Data sources:
 * - todos table (completed last 7 days, open/in-progress/blocked)
 * - orchestrator_tasks table (completed last 7 days)
 * - Git log (commits last 7 days)
 * - /api/usage/history (daily cost breakdown)
 */

import { execFile } from 'node:child_process';
import { query } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { sendToHuman } from './helpers/send-to-human.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('saturday-report');

// ── Types ────────────────────────────────────────────────────

interface CompletedTodo {
  id: number;
  title: string;
  status: string;
  updated_at: string | null;
}

interface CompletedOrchestratorTask {
  id: string;
  title: string;
  status: string;
  result: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
}

interface CarryoverTodo {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  created_at: string | null;
}

interface DailyUsageEntry {
  date: string;
  totalCost: number;
  inputTokens?: number;
  outputTokens?: number;
}

// ── Helpers ──────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function execCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function fetchLocal(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const resp = await fetch(url, init);
  return {
    ok: resp.ok,
    status: resp.status,
    json: () => resp.json() as Promise<unknown>,
  };
}

/**
 * Format a date string (ISO or SQLite datetime) into a short human-readable form.
 * Returns the date portion only (e.g. "Apr 13").
 */
function fmtDate(dt: string | null | undefined): string {
  if (!dt) return '?';
  try {
    const d = new Date(dt.includes('T') ? dt : dt.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dt.slice(0, 10);
  }
}

/**
 * Truncate a string to maxLen, appending "…" if trimmed.
 */
function trunc(s: string | null | undefined, maxLen: number): string {
  if (!s) return '(none)';
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '\u2026' : s;
}

// ── Section: Completed Todos ─────────────────────────────────

function buildCompletedTodosSection(): { count: number; lines: string[] } {
  try {
    const rows = query<CompletedTodo>(
      `SELECT id, title, status, updated_at FROM tasks
       WHERE kind = 'todo'
         AND status = 'completed'
         AND updated_at >= datetime('now', '-7 days')
       ORDER BY updated_at DESC`,
    );

    if (rows.length === 0) {
      return { count: 0, lines: ['No todos completed this week'] };
    }

    const lines = rows.map(r => `\u2022 ${trunc(r.title, 60)} \u2014 ${fmtDate(r.updated_at)}`);
    return { count: rows.length, lines };
  } catch (err) {
    log.warn('Failed to get completed todos', { error: errMsg(err) });
    return { count: 0, lines: ['(todo data unavailable)'] };
  }
}

// ── Section: Orchestrator Tasks Completed ────────────────────

function buildOrchestratorTasksSection(): { count: number; lines: string[] } {
  try {
    const rows = query<CompletedOrchestratorTask>(
      `SELECT id, title, status, result, started_at, completed_at, updated_at
       FROM orchestrator_tasks
       WHERE status = 'completed'
         AND updated_at >= datetime('now', '-7 days')
       ORDER BY updated_at DESC`,
    );

    if (rows.length === 0) {
      return { count: 0, lines: ['No orchestrator tasks completed this week'] };
    }

    const lines = rows.map(r => {
      const snippet = r.result ? ' \u2014 ' + trunc(r.result, 50) : '';
      return `\u2022 ${trunc(r.title, 60)}${snippet}`;
    });
    return { count: rows.length, lines };
  } catch (err) {
    log.warn('Failed to get orchestrator tasks', { error: errMsg(err) });
    return { count: 0, lines: ['(orchestrator task data unavailable)'] };
  }
}

// ── Section: Git Activity ────────────────────────────────────

async function buildGitSection(repoDir: string): Promise<{ count: number; lines: string[] }> {
  try {
    const output = await execCommand('git', [
      '-C', repoDir,
      'log', '--oneline', '--since=7 days ago', '--no-merges',
    ]);
    const commitLines = output.trim().split('\n').filter(l => l.length > 0);

    if (commitLines.length === 0) {
      return { count: 0, lines: ['No commits this week'] };
    }

    // Show up to last 15
    const shown = commitLines.slice(0, 15);
    const lines = shown.map(l => {
      const [hash, ...rest] = l.split(' ');
      return `\u2022 <code>${hash}</code> ${trunc(rest.join(' '), 55)}`;
    });

    if (commitLines.length > 15) {
      lines.push(`\u2026 and ${commitLines.length - 15} more`);
    }

    return { count: commitLines.length, lines };
  } catch (err) {
    log.warn('Failed to get git activity', { error: errMsg(err) });
    return { count: 0, lines: ['(git data unavailable)'] };
  }
}

// ── Section: Weekly Cost ─────────────────────────────────────

async function buildCostSection(port: number): Promise<string[]> {
  try {
    const resp = await fetchLocal(`http://127.0.0.1:${port}/api/usage/history`);
    if (!resp.ok) {
      return ['(usage data unavailable — API error)'];
    }

    const data = await resp.json() as { history?: DailyUsageEntry[] } | DailyUsageEntry[] | unknown;

    // The API may return { history: [...] } or a bare array
    let history: DailyUsageEntry[] = [];
    if (Array.isArray(data)) {
      history = data as DailyUsageEntry[];
    } else if (data && typeof data === 'object' && 'history' in (data as object)) {
      history = (data as { history: DailyUsageEntry[] }).history ?? [];
    }

    // Filter to last 7 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const week = history.filter(e => e.date >= cutoffStr);

    if (week.length === 0) {
      return ['No usage data for this week'];
    }

    const total = week.reduce((sum, e) => sum + (e.totalCost ?? 0), 0);
    const avg = total / week.length;

    const lines: string[] = [
      `Total: <b>$${total.toFixed(2)}</b>`,
      `Daily avg: $${avg.toFixed(2)}`,
      '',
    ];

    // Compact daily table
    for (const e of week.sort((a, b) => a.date.localeCompare(b.date))) {
      const d = new Date(e.date + 'T12:00:00Z');
      const label = d.toLocaleDateString('en-US', {
        timeZone: 'America/Chicago',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      lines.push(`  ${label}: $${(e.totalCost ?? 0).toFixed(2)}`);
    }

    return lines;
  } catch (err) {
    log.warn('Failed to get usage history', { error: errMsg(err) });
    return ['(usage data unavailable)'];
  }
}

// ── Section: Carryover ───────────────────────────────────────

function buildCarryoverSection(): { count: number; lines: string[] } {
  try {
    const rows = query<CarryoverTodo>(
      `SELECT id, title, status, priority, created_at FROM tasks
       WHERE kind = 'todo'
         AND status IN ('pending', 'in_progress', 'blocked')
       ORDER BY priority DESC, created_at ASC
       LIMIT 20`,
    );

    if (rows.length === 0) {
      return { count: 0, lines: ['No open items — clean slate!'] };
    }

    const priorityLabel: Record<string, string> = {
      high: 'high',
      medium: 'med',
      low: 'low',
    };

    const lines = rows.map(r => {
      const p = r.priority ? priorityLabel[r.priority] ?? r.priority : 'med';
      const statusTag = r.status === 'blocked' ? ' [blocked]' : r.status === 'in_progress' ? ' [wip]' : '';
      return `\u2022 [${p}] ${trunc(r.title, 60)}${statusTag}`;
    });

    return { count: rows.length, lines };
  } catch (err) {
    log.warn('Failed to get carryover todos', { error: errMsg(err) });
    return { count: 0, lines: ['(carryover data unavailable)'] };
  }
}

// ── Formatting ───────────────────────────────────────────────

function formatReport(opts: {
  weekStart: string;
  weekEnd: string;
  completedTodos: { count: number; lines: string[] };
  orchTasks: { count: number; lines: string[] };
  git: { count: number; lines: string[] };
  costLines: string[];
  carryover: { count: number; lines: string[] };
  generatedAt: string;
}): string {
  const parts: string[] = [];

  parts.push(`<b>\uD83D\uDCCA Weekly Status Report</b>`);
  parts.push(`<i>Week of ${opts.weekStart} \u2014 ${opts.weekEnd}</i>`);
  parts.push('');

  // Completed todos
  parts.push(`<b>\u2705 Completed (${opts.completedTodos.count})</b>`);
  for (const l of opts.completedTodos.lines) parts.push(l);
  parts.push('');

  // Orchestrator tasks
  parts.push(`<b>\uD83D\uDD27 Tasks Completed (${opts.orchTasks.count})</b>`);
  for (const l of opts.orchTasks.lines) parts.push(l);
  parts.push('');

  // Git
  parts.push(`<b>\uD83D\uDCBB Git Activity (${opts.git.count} commit${opts.git.count === 1 ? '' : 's'})</b>`);
  for (const l of opts.git.lines) parts.push(l);
  parts.push('');

  // Cost
  parts.push(`<b>\uD83D\uDCB0 Weekly Cost</b>`);
  for (const l of opts.costLines) parts.push(l);
  parts.push('');

  // Carryover
  parts.push(`<b>\uD83D\uDCCB Carryover (${opts.carryover.count} open)</b>`);
  for (const l of opts.carryover.lines) parts.push(l);
  parts.push('');

  parts.push(`<b>Generated:</b> ${opts.generatedAt}`);

  return parts.join('\n').trim();
}

// ── Delivery ─────────────────────────────────────────────────

async function sendReport(message: string, port: number, channels?: string[]): Promise<void> {
  // Auth-family fix 2026-06-05: bare fetch 401'd against the #290 role gate.
  // sendToHuman = in-process router first, HTTP+daemon-token fallback.
  const payload: { message: string; channels?: string[]; parse_mode?: string } = {
    message,
    parse_mode: 'HTML',
  };
  if (channels && channels.length > 0) {
    payload.channels = channels;
  }

  const result = await sendToHuman(payload, port);
  if (!result.ok) {
    throw new Error(`Send API returned ${result.status}`);
  }
}

// ── Main ─────────────────────────────────────────────────────

async function run(taskConfig: Record<string, unknown>): Promise<void> {
  const startMs = Date.now();
  const repoDir = taskConfig.repo_dir as string | undefined ?? '/Users/bmo/KKit-INSTANCE-A';

  const config = loadConfig();
  const daemonCfg = (config as unknown as Record<string, Record<string, unknown>>)?.daemon;
  const port = (daemonCfg?.port as number | undefined) ?? 3847;

  // Date calculations
  const now = new Date();
  const weekEnd = now.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const weekStartDate = new Date(now);
  weekStartDate.setDate(weekStartDate.getDate() - 6);
  const weekStart = weekStartDate.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
  });

  const generatedAt = now.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  log.info('Building Saturday status report');

  // Gather sections — async ones in parallel, sync DB queries after
  const [gitResult, costLines] = await Promise.all([
    buildGitSection(repoDir),
    buildCostSection(port),
  ]);

  const completedTodos = buildCompletedTodosSection();
  const orchTasks = buildOrchestratorTasksSection();
  const carryover = buildCarryoverSection();

  const message = formatReport({
    weekStart,
    weekEnd,
    completedTodos,
    orchTasks,
    git: gitResult,
    costLines,
    carryover,
    generatedAt,
  });

  const channels = taskConfig.channels as string[] | undefined ?? ['telegram'];

  try {
    await sendReport(message, port, channels);
    const durationMs = Date.now() - startMs;
    log.info('Saturday report sent', { durationMs });
  } catch (err) {
    log.error('Failed to send Saturday report', { error: errMsg(err) });
    // Attempt a brief error notification
    try {
      const errMsg2 = `<b>Saturday Report Error</b>\nFailed to send weekly report: ${errMsg(err)}`;
      await sendReport(errMsg2, port, channels);
    } catch {
      // best effort
    }
  }
}

// ── Registration ─────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('saturday-status-report', async (ctx) => {
    await run(ctx.config);
  });
}
