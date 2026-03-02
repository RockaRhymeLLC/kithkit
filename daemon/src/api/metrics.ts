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

const log = createLogger('api-metrics');

// ── Request Logging ──────────────────────────────────────────

/**
 * Extract agent identifier from request headers.
 * Checks X-Agent first, then falls back to User-Agent.
 */
function extractAgentId(req: http.IncomingMessage): string | null {
  const xAgent = req.headers['x-agent'];
  if (typeof xAgent === 'string' && xAgent.length > 0) return xAgent;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) return ua;
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
      conditions.push("hour >= datetime('now', ?)")
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

  return false;
}
