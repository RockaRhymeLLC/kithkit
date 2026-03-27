/**
 * Daily Digest — morning summary report.
 *
 * Runs daily (configured via cron in kithkit.config.yaml).
 * Gathers overnight activity, metrics, blockers, and team status,
 * then delivers a concise digest via the daemon send API.
 *
 * Delivery channels are configured per-instance in the scheduler task
 * config (`channels` array). Defaults to all configured channels if
 * no channels are specified.
 *
 * Data sources:
 * - Git log (PRs merged, recent commits)
 * - Daemon todos API (completed overnight)
 * - Orchestrator tasks (failed/blocked)
 * - api_metrics_hourly table (request volume, error rates, top endpoints)
 * - Peer heartbeat state (team online status)
 *
 * Partial failures are noted inline — a single failing data source
 * does not block the rest of the digest.
 */

import { execFile } from 'node:child_process';
import { query } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('daily-digest');

// ── Types ────────────────────────────────────────────────────

interface DigestSection {
  header: string;
  lines: string[];
}

interface MetricsSummary {
  total_requests: number;
  success_count: number;
  error_4xx: number;
  error_5xx: number;
  avg_latency_ms: number;
}

interface TopEndpoint {
  endpoint: string;
  method: string;
  total_requests: number;
}

interface TodoRow {
  id: number;
  title: string;
  status: string;
  updated_at: string | null;
}

interface OrchestratorTask {
  id: string;
  title: string;
  status: string;
  error: string | null;
}

interface PeerConfig {
  name: string;
  host: string;
  port: number;
}

// ── Data Gathering ───────────────────────────────────────────

/**
 * Get recent git activity (PRs merged, commits) from the last 24h.
 */
async function getGitActivity(repoDir: string): Promise<DigestSection> {
  const lines: string[] = [];

  try {
    // Recent commits (last 24h)
    const commits = await execCommand('git', [
      '-C', repoDir,
      'log', '--oneline', '--since=24 hours ago', '--all',
    ]);
    const commitLines = commits.trim().split('\n').filter(l => l.length > 0);

    // Count PRs merged (look for "Merge pull request" in commit messages)
    const prsMerged = commitLines.filter(l => l.includes('Merge pull request'));
    if (prsMerged.length > 0) {
      lines.push(`${prsMerged.length} PR${prsMerged.length === 1 ? '' : 's'} merged`);
    }

    // Count non-merge commits
    const regularCommits = commitLines.filter(l => !l.startsWith('Merge'));
    if (regularCommits.length > 0) {
      lines.push(`${regularCommits.length} commit${regularCommits.length === 1 ? '' : 's'}`);
    }

    if (lines.length === 0) {
      lines.push('No git activity overnight');
    }
  } catch (err) {
    lines.push('(git data unavailable)');
    log.warn('Failed to get git activity', { error: errMsg(err) });
  }

  return { header: 'Overnight Activity', lines };
}

/**
 * Get todos completed in the last 24h and any open blockers.
 */
function getTodoActivity(): DigestSection {
  const lines: string[] = [];

  try {
    // Completed todos in last 24h (todos table has updated_at, not completed_at)
    const completed = query<TodoRow>(
      `SELECT id, title, status FROM todos
       WHERE status = 'completed'
         AND updated_at >= datetime('now', '-24 hours')
       ORDER BY updated_at DESC
       LIMIT 5`,
    );

    if (completed.length > 0) {
      lines.push(`${completed.length} todo${completed.length === 1 ? '' : 's'} completed`);
    }

    // Open todos count
    const openResult = query<{ count: number }>(
      `SELECT COUNT(*) as count FROM todos WHERE status NOT IN ('completed', 'cancelled')`,
    );
    const openCount = openResult[0]?.count ?? 0;
    if (openCount > 0) {
      lines.push(`${openCount} open todo${openCount === 1 ? '' : 's'} remaining`);
    }

    if (lines.length === 0) {
      lines.push('No todo changes overnight');
    }
  } catch (err) {
    lines.push('(todo data unavailable)');
    log.warn('Failed to get todo activity', { error: errMsg(err) });
  }

  return { header: 'Todos', lines };
}

/**
 * Get metrics snapshot from the last 24h.
 */
function getMetricsSnapshot(): DigestSection {
  const lines: string[] = [];

  try {
    // Summary for last 24h
    const summaryRows = query<MetricsSummary>(
      `SELECT
         COALESCE(SUM(total_requests), 0) as total_requests,
         COALESCE(SUM(success_count), 0) as success_count,
         COALESCE(SUM(error_4xx), 0) as error_4xx,
         COALESCE(SUM(error_5xx), 0) as error_5xx,
         CASE WHEN SUM(total_requests) > 0
           THEN SUM(avg_latency_ms * total_requests) / SUM(total_requests)
           ELSE 0 END as avg_latency_ms
       FROM api_metrics_hourly
       WHERE hour >= datetime('now', '-24 hours')`,
    );
    const s = summaryRows[0];

    if (s && s.total_requests > 0) {
      const errorRate = ((s.error_4xx + s.error_5xx) / s.total_requests * 100).toFixed(1);
      lines.push(`${s.total_requests} requests, ${errorRate}% error rate`);
      lines.push(`Avg latency: ${Math.round(s.avg_latency_ms)}ms`);

      if (s.error_5xx > 0) {
        lines.push(`\u26a0\ufe0f ${s.error_5xx} server error${s.error_5xx === 1 ? '' : 's'} (5xx)`);
      }
    } else {
      lines.push('No API traffic in last 24h');
    }

    // Top 3 endpoints by volume
    const topEndpoints = query<TopEndpoint>(
      `SELECT endpoint, method, SUM(total_requests) as total_requests
       FROM api_metrics_hourly
       WHERE hour >= datetime('now', '-24 hours')
       GROUP BY endpoint, method
       ORDER BY total_requests DESC
       LIMIT 3`,
    );

    if (topEndpoints.length > 0) {
      const topList = topEndpoints
        .map(e => `${e.method} ${e.endpoint} (${e.total_requests})`)
        .join(', ');
      lines.push(`Top: ${topList}`);
    }
  } catch (err) {
    lines.push('(metrics unavailable)');
    log.warn('Failed to get metrics', { error: errMsg(err) });
  }

  return { header: 'Metrics (24h)', lines };
}

/**
 * Get failed orchestrator tasks and unresolved blockers.
 */
function getBlockers(): DigestSection {
  const lines: string[] = [];

  try {
    const failed = query<OrchestratorTask>(
      `SELECT id, title, status, error FROM orchestrator_tasks
       WHERE status = 'failed'
         AND updated_at >= datetime('now', '-24 hours')
       ORDER BY updated_at DESC
       LIMIT 5`,
    );

    if (failed.length > 0) {
      lines.push(`${failed.length} failed task${failed.length === 1 ? '' : 's'}:`);
      for (const t of failed) {
        const shortTitle = t.title.length > 50 ? t.title.slice(0, 47) + '...' : t.title;
        lines.push(`  \u2022 ${shortTitle}`);
      }
    }

    // Check for stale in-progress tasks (running > 2h)
    const stale = query<OrchestratorTask>(
      `SELECT id, title, status, error FROM orchestrator_tasks
       WHERE status = 'in_progress'
         AND started_at <= datetime('now', '-2 hours')
       LIMIT 3`,
    );

    if (stale.length > 0) {
      lines.push(`${stale.length} stale task${stale.length === 1 ? '' : 's'} (in_progress > 2h)`);
    }

    if (lines.length === 0) {
      lines.push('No blockers');
    }
  } catch (err) {
    lines.push('(blocker data unavailable)');
    log.warn('Failed to get blockers', { error: errMsg(err) });
  }

  return { header: 'Blockers', lines };
}

/**
 * Get team status from peer heartbeat data.
 */
async function getTeamStatus(): Promise<DigestSection> {
  const lines: string[] = [];

  try {
    const config = loadConfig();
    const agentComms = (config as unknown as Record<string, unknown>)['agent-comms'] as
      { enabled: boolean; peers?: PeerConfig[] } | undefined;

    if (!agentComms?.enabled || !agentComms.peers?.length) {
      lines.push('No peers configured');
      return { header: 'Team', lines };
    }

    // Try to ping each peer
    for (const peer of agentComms.peers) {
      try {
        const result = await fetchWithTimeout(
          `http://${peer.host}:${peer.port}/health`,
          3000,
        );
        if (result.ok) {
          lines.push(`${peer.name}: online`);
        } else {
          lines.push(`${peer.name}: unreachable`);
        }
      } catch {
        lines.push(`${peer.name}: offline`);
      }
    }
  } catch (err) {
    lines.push('(peer status unavailable)');
    log.warn('Failed to get team status', { error: errMsg(err) });
  }

  return { header: 'Team', lines };
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format the digest as Telegram-friendly text.
 * Uses bold headers, keeps it under 15 lines.
 */
function formatDigest(sections: DigestSection[], date: string): string {
  const parts: string[] = [];
  parts.push(`<b>Daily Digest — ${date}</b>`);
  parts.push('');

  for (const section of sections) {
    if (section.lines.length === 0) continue;
    parts.push(`<b>${section.header}</b>`);
    for (const line of section.lines) {
      parts.push(line);
    }
    parts.push('');
  }

  return parts.join('\n').trim();
}

// ── Delivery ─────────────────────────────────────────────────

/**
 * Send the digest via the daemon's send API.
 * Channels are determined by the task config (`channels` array).
 * If no channels are configured, omits the field to let the send API
 * use its default routing.
 */
async function sendDigest(message: string, channels?: string[]): Promise<void> {
  const config = loadConfig();
  const port = (config as unknown as Record<string, Record<string, unknown>>)?.daemon?.port ?? 3847;

  const payload: Record<string, unknown> = {
    message,
    parse_mode: 'HTML',
  };
  if (channels && channels.length > 0) {
    payload.channels = channels;
  }
  const body = JSON.stringify(payload);

  const result = await fetchLocal(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!result.ok) {
    throw new Error(`Send API returned ${result.status}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function execCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * HTTP fetch with timeout using Node.js built-in fetch.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return { ok: resp.ok, status: resp.status };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLocal(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number }> {
  const resp = await fetch(url, init);
  return { ok: resp.ok, status: resp.status };
}

// ── Main ─────────────────────────────────────────────────────

async function run(config: Record<string, unknown>): Promise<void> {
  const startMs = Date.now();
  const repoDir = config.repo_dir as string | undefined ?? process.cwd();

  // Format date in CT
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  log.info('Building daily digest');

  // Gather all sections (parallel where possible)
  const [gitSection, teamSection] = await Promise.all([
    getGitActivity(repoDir),
    getTeamStatus(),
  ]);

  // These are synchronous DB queries
  const todoSection = getTodoActivity();
  const metricsSection = getMetricsSnapshot();
  const blockerSection = getBlockers();

  const sections = [gitSection, todoSection, metricsSection, blockerSection, teamSection];
  const message = formatDigest(sections, dateStr);

  // Send via daemon — channels come from task config (instance-specific)
  const channels = config.channels as string[] | undefined;
  await sendDigest(message, channels);

  const durationMs = Date.now() - startMs;
  log.info('Daily digest sent', { durationMs });
}

// ── Registration ─────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('daily-digest', async (ctx) => {
    await run(ctx.config);
  });
}
