/**
 * API Metrics — request logging and metrics endpoint.
 *
 * Two responsibilities:
 * 1. logRequest() — called from main.ts after each request to record method,
 *    path, status, latency, agent, and error field names.
 * 2. handleMetricsRoute() — serves GET /api/metrics with aggregated data.
 */

import type http from 'node:http';
import { exec, query } from '../core/db.js';
import { json, withTimestamp, parseBody } from './helpers.js';
import { createLogger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';

const log = createLogger('api-metrics');

// ── Ingest rate limiting ──────────────────────────────────────

/** Per-agent POST count within the current minute window. */
interface RateLimitEntry {
  count: number;
  windowStart: number; // Unix ms
}

const _ingestRateMap = new Map<string, RateLimitEntry>();
const INGEST_RATE_LIMIT = 10;    // max POSTs per minute per agent
const RATE_WINDOW_MS = 60_000;

/**
 * Returns true if the agent is over the rate limit.
 * Resets the counter automatically when the window rolls over.
 */
function isRateLimited(agent: string): boolean {
  const now = Date.now();
  const entry = _ingestRateMap.get(agent);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    _ingestRateMap.set(agent, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > INGEST_RATE_LIMIT;
}

/** Prune stale entries from the rate limit map (entries older than one window). */
function pruneStaleRateLimitEntries(): void {
  const now = Date.now();
  for (const [key, entry] of _ingestRateMap) {
    if (now - entry.windowStart >= RATE_WINDOW_MS * 2) {
      _ingestRateMap.delete(key);
    }
  }
}

// Sweep stale entries every 5 minutes to prevent unbounded growth
setInterval(pruneStaleRateLimitEntries, 5 * 60 * 1000).unref();

/** Exposed for tests only — resets the in-memory rate limit state. */
export function _resetIngestRateLimitForTesting(): void {
  _ingestRateMap.clear();
}

// ── Request Logging ──────────────────────────────────────────

/**
 * Extract agent identifier from request headers.
 * Checks X-Agent first, then falls back to the configured agent name
 * so that local traffic is always attributed to this daemon's agent.
 */
function extractAgentId(req: http.IncomingMessage): string | null {
  const xAgent = req.headers['x-agent'];
  if (typeof xAgent === 'string' && xAgent.length > 0) return xAgent;
  // Local traffic without X-Agent → attribute to this daemon's agent
  const config = loadConfig();
  if (config.agent?.name) return config.agent.name.toLowerCase();
  return null;
}

/**
 * Log a completed request to api_request_logs.
 * Called from main.ts after each response is sent.
 *
 * On 4xx responses, logs the top-level field names from the request body
 * (not values) to help diagnose bad requests.
 */
export function logRequest(
  req: http.IncomingMessage,
  statusCode: number,
  latencyMs: number,
  bodyFieldNames?: string[] | null,
): void {
  try {
    const method = req.method ?? 'UNKNOWN';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const agentId = extractAgentId(req);

    // Only record field names on 4xx errors
    const errorFields = statusCode >= 400 && statusCode < 500 && bodyFieldNames?.length
      ? JSON.stringify(bodyFieldNames)
      : null;

    exec(
      `INSERT INTO api_request_logs (method, path, status_code, latency_ms, agent_id, error_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      method,
      path,
      statusCode,
      latencyMs,
      agentId,
      errorFields,
    );
  } catch (err) {
    // Never let metrics logging break a request
    log.error('Failed to log request', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Metrics Endpoint ─────────────────────────────────────────

interface HourlyRow {
  hour: string;
  endpoint: string;
  method: string;
  total_requests: number;
  success_count: number;
  error_4xx: number;
  error_5xx: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  agent_id: string | null;
}

interface RepeatOffenderRow {
  agent_id: string;
  endpoint: string;
  method: string;
  error_count: number;
  latest_hour: string;
}

/**
 * Handle GET /api/metrics — returns aggregated metrics data.
 *
 * Query parameters:
 * - endpoint: filter by endpoint path
 * - agent: filter by agent_id
 * - from: start time (ISO 8601 or YYYY-MM-DD HH)
 * - to: end time (ISO 8601 or YYYY-MM-DD HH)
 * - hours: number of hours to look back (default: 24)
 */
export async function handleMetricsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith('/api/metrics')) return false;
  const method = req.method ?? '';

  // GET /api/metrics — aggregated data
  if (pathname === '/api/metrics' && method === 'GET') {
    const endpointFilter = searchParams.get('endpoint');
    const agentFilter = searchParams.get('agent');
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');
    const hoursParam = searchParams.get('hours');
    const hours = hoursParam ? parseInt(hoursParam, 10) : 24;

    // Build WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (fromParam) {
      conditions.push('hour >= ?');
      params.push(fromParam);
    } else {
      conditions.push("hour >= strftime('%Y-%m-%d %H:00', 'now', ?)")
      params.push(`-${hours} hours`);
    }
    if (toParam) {
      conditions.push('hour <= ?');
      params.push(toParam);
    }
    if (endpointFilter) {
      conditions.push('endpoint = ?');
      params.push(endpointFilter);
    }
    if (agentFilter) {
      conditions.push('agent_id = ?');
      params.push(agentFilter);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Summary stats
    const summaryRows = query<{
      total_requests: number;
      success_count: number;
      error_4xx: number;
      error_5xx: number;
      avg_latency: number;
    }>(
      `SELECT
         COALESCE(SUM(total_requests), 0) as total_requests,
         COALESCE(SUM(success_count), 0) as success_count,
         COALESCE(SUM(error_4xx), 0) as error_4xx,
         COALESCE(SUM(error_5xx), 0) as error_5xx,
         CASE WHEN SUM(total_requests) > 0
           THEN SUM(avg_latency_ms * total_requests) / SUM(total_requests)
           ELSE 0 END as avg_latency
       FROM api_metrics_hourly ${where}`,
      ...params,
    );
    const summary = summaryRows[0] ?? { total_requests: 0, success_count: 0, error_4xx: 0, error_5xx: 0, avg_latency: 0 };

    // Hourly breakdown
    const hourlyBreakdown = query<{
      hour: string;
      total_requests: number;
      success_count: number;
      error_4xx: number;
      error_5xx: number;
      avg_latency_ms: number;
    }>(
      `SELECT
         hour,
         SUM(total_requests) as total_requests,
         SUM(success_count) as success_count,
         SUM(error_4xx) as error_4xx,
         SUM(error_5xx) as error_5xx,
         CASE WHEN SUM(total_requests) > 0
           THEN SUM(avg_latency_ms * total_requests) / SUM(total_requests)
           ELSE 0 END as avg_latency_ms
       FROM api_metrics_hourly ${where}
       GROUP BY hour ORDER BY hour`,
      ...params,
    );

    // Per-endpoint breakdown
    const endpointBreakdown = query<{
      endpoint: string;
      method: string;
      total_requests: number;
      error_4xx: number;
      error_5xx: number;
      avg_latency_ms: number;
      p95_latency_ms: number;
    }>(
      `SELECT
         endpoint,
         method,
         SUM(total_requests) as total_requests,
         SUM(error_4xx) as error_4xx,
         SUM(error_5xx) as error_5xx,
         CASE WHEN SUM(total_requests) > 0
           THEN SUM(avg_latency_ms * total_requests) / SUM(total_requests)
           ELSE 0 END as avg_latency_ms,
         MAX(p95_latency_ms) as p95_latency_ms
       FROM api_metrics_hourly ${where}
       GROUP BY endpoint, method
       ORDER BY SUM(total_requests) DESC`,
      ...params,
    );

    // Per-agent breakdown
    const agentBreakdown = query<{
      agent_id: string;
      total_requests: number;
      error_4xx: number;
      error_5xx: number;
      avg_latency_ms: number;
    }>(
      `SELECT
         COALESCE(agent_id, 'unknown') as agent_id,
         SUM(total_requests) as total_requests,
         SUM(error_4xx) as error_4xx,
         SUM(error_5xx) as error_5xx,
         CASE WHEN SUM(total_requests) > 0
           THEN SUM(avg_latency_ms * total_requests) / SUM(total_requests)
           ELSE 0 END as avg_latency_ms
       FROM api_metrics_hourly ${where}
       GROUP BY agent_id
       ORDER BY SUM(total_requests) DESC`,
      ...params,
    );

    // Top error endpoints
    const topErrors = query<{
      endpoint: string;
      method: string;
      total_errors: number;
    }>(
      `SELECT
         endpoint,
         method,
         SUM(error_4xx + error_5xx) as total_errors
       FROM api_metrics_hourly ${where}
       GROUP BY endpoint, method
       HAVING total_errors > 0
       ORDER BY total_errors DESC
       LIMIT 10`,
      ...params,
    );

    // Repeat offenders: same agent + same endpoint + errors across multiple hours
    const repeatOffenders = query<RepeatOffenderRow>(
      `SELECT
         agent_id,
         endpoint,
         method,
         SUM(error_4xx + error_5xx) as error_count,
         MAX(hour) as latest_hour
       FROM api_metrics_hourly
       ${where ? where + ' AND agent_id IS NOT NULL' : 'WHERE agent_id IS NOT NULL'}
       GROUP BY agent_id, endpoint, method
       HAVING error_count >= 3
       ORDER BY error_count DESC
       LIMIT 20`,
      ...params,
    );

    json(res, 200, withTimestamp({
      summary: {
        total_requests: summary.total_requests,
        success_count: summary.success_count,
        error_4xx: summary.error_4xx,
        error_5xx: summary.error_5xx,
        error_rate_4xx: summary.total_requests > 0 ? summary.error_4xx / summary.total_requests : 0,
        error_rate_5xx: summary.total_requests > 0 ? summary.error_5xx / summary.total_requests : 0,
        avg_latency_ms: Math.round(summary.avg_latency * 100) / 100,
      },
      hourly: hourlyBreakdown,
      endpoints: endpointBreakdown,
      agents: agentBreakdown,
      top_errors: topErrors,
      repeat_offenders: repeatOffenders,
      filters: {
        endpoint: endpointFilter,
        agent: agentFilter,
        from: fromParam,
        to: toParam,
        hours,
      },
    }));
    return true;
  }

  // POST /api/metrics/ingest — receive batched hourly metrics from remote agents
  if (pathname === '/api/metrics/ingest' && method === 'POST') {
    // ── Shared secret check ───────────────────────────────────
    const expectedKey = process.env['METRICS_INGEST_KEY'] ??
      (loadConfig() as unknown as Record<string, Record<string, unknown>>)
        ?.metrics_ingest?.key as string | undefined ??
      null;

    if (expectedKey) {
      const providedKey = req.headers['x-metrics-key'];
      if (typeof providedKey !== 'string' || providedKey !== expectedKey) {
        json(res, 401, withTimestamp({ error: 'Invalid or missing X-Metrics-Key' }));
        return true;
      }
    }

    // ── Parse and validate body ───────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await parseBody(req);
    } catch (err) {
      json(res, 400, withTimestamp({ error: err instanceof Error ? err.message : 'Invalid request body' }));
      return true;
    }

    if (!body.agent || typeof body.agent !== 'string') {
      json(res, 400, withTimestamp({ error: 'agent is required (string)' }));
      return true;
    }
    const agentName = body.agent;

    if (!Array.isArray(body.hourly)) {
      json(res, 400, withTimestamp({ error: 'hourly is required (array)' }));
      return true;
    }
    if (body.hourly.length > 500) {
      json(res, 400, withTimestamp({ error: 'hourly array exceeds maximum of 500 items' }));
      return true;
    }

    // ── Rate limit ────────────────────────────────────────────
    if (isRateLimited(agentName)) {
      json(res, 429, withTimestamp({ error: 'Rate limit exceeded — max 10 requests per minute per agent' }));
      return true;
    }

    // ── Upsert each hourly row ────────────────────────────────
    let ingested = 0;
    for (const item of body.hourly as unknown[]) {
      if (!item || typeof item !== 'object') {
        log.warn('Skipping non-object hourly item', { agent: agentName });
        continue;
      }
      const row = item as Record<string, unknown>;

      // Required fields
      if (typeof row['hour'] !== 'string' || !row['hour']) continue;
      if (typeof row['endpoint'] !== 'string' || !row['endpoint']) continue;
      if (typeof row['method'] !== 'string' || !row['method']) continue;
      if (typeof row['total_requests'] !== 'number') continue;

      // Optional fields with defaults
      const successCount    = typeof row['success_count']  === 'number' ? row['success_count']  : 0;
      const error4xx        = typeof row['error_4xx']      === 'number' ? row['error_4xx']      : 0;
      const error5xx        = typeof row['error_5xx']      === 'number' ? row['error_5xx']      : 0;
      const avgLatencyMs    = typeof row['avg_latency_ms'] === 'number' ? row['avg_latency_ms'] : 0;
      const p95LatencyMs    = typeof row['p95_latency_ms'] === 'number' ? row['p95_latency_ms'] : 0;

      exec(
        `INSERT INTO api_metrics_hourly
           (hour, endpoint, method, total_requests, success_count, error_4xx, error_5xx,
            avg_latency_ms, p95_latency_ms, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour, endpoint, method, COALESCE(agent_id, ''))
         DO UPDATE SET
           total_requests = excluded.total_requests,
           success_count  = excluded.success_count,
           error_4xx      = excluded.error_4xx,
           error_5xx      = excluded.error_5xx,
           avg_latency_ms = excluded.avg_latency_ms,
           p95_latency_ms = MAX(api_metrics_hourly.p95_latency_ms, excluded.p95_latency_ms)`,
        row['hour'],
        row['endpoint'],
        row['method'],
        row['total_requests'],
        successCount,
        error4xx,
        error5xx,
        avgLatencyMs,
        p95LatencyMs,
        agentName,
      );
      ingested += 1;
    }

    log.info('Metrics ingested', { agent: agentName, ingested });
    json(res, 200, withTimestamp({ ingested, agent: agentName }));
    return true;
  }

  return false;
}
