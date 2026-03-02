/**
 * API Metrics Aggregation — hourly rollup and raw log purge.
 *
 * Runs hourly (configured in scheduler):
 * 1. Aggregates api_request_logs into api_metrics_hourly for the previous hour.
 * 2. Purges raw logs older than 24 hours.
 *
 * Aggregation groups by (hour, endpoint, method, agent_id) and computes:
 * - total_requests, success_count (2xx/3xx), error_4xx, error_5xx
 * - avg_latency_ms, p95_latency_ms (approximated via sorted list)
 */

import { query, exec, getDatabase } from '../../core/db.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('api-metrics-aggregation');

interface AggGroup {
  hour: string;
  endpoint: string;
  method: string;
  agent_id: string | null;
  total_requests: number;
  success_count: number;
  error_4xx: number;
  error_5xx: number;
  avg_latency_ms: number;
}

interface LatencyRow {
  latency_ms: number;
}

/**
 * Aggregate raw request logs for a given hour into hourly metrics.
 */
function aggregateHour(hour: string): number {
  // Find all distinct (endpoint, method, agent_id) groups for this hour
  const groups = query<AggGroup>(
    `SELECT
       strftime('%Y-%m-%d %H:00', timestamp) as hour,
       path as endpoint,
       method,
       agent_id,
       COUNT(*) as total_requests,
       SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END) as success_count,
       SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) as error_4xx,
       SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as error_5xx,
       AVG(latency_ms) as avg_latency_ms
     FROM api_request_logs
     WHERE strftime('%Y-%m-%d %H:00', timestamp) = ?
     GROUP BY path, method, agent_id`,
    hour,
  );

  if (groups.length === 0) return 0;

  const db = getDatabase();
  const upsert = db.prepare(
    `INSERT INTO api_metrics_hourly (hour, endpoint, method, total_requests, success_count, error_4xx, error_5xx, avg_latency_ms, p95_latency_ms, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (hour, endpoint, method, COALESCE(agent_id, ''))
     DO UPDATE SET
       total_requests = excluded.total_requests,
       success_count = excluded.success_count,
       error_4xx = excluded.error_4xx,
       error_5xx = excluded.error_5xx,
       avg_latency_ms = excluded.avg_latency_ms,
       p95_latency_ms = excluded.p95_latency_ms`,
  );

  let rowsInserted = 0;
  for (const group of groups) {
    // Calculate p95 latency for this group
    const latencies = query<LatencyRow>(
      `SELECT latency_ms FROM api_request_logs
       WHERE strftime('%Y-%m-%d %H:00', timestamp) = ?
         AND path = ? AND method = ?
         AND (agent_id = ? OR (agent_id IS NULL AND ? IS NULL))
       ORDER BY latency_ms ASC`,
      hour,
      group.endpoint,
      group.method,
      group.agent_id,
      group.agent_id,
    );

    let p95 = 0;
    if (latencies.length > 0) {
      const idx = Math.ceil(latencies.length * 0.95) - 1;
      p95 = latencies[Math.max(0, idx)]!.latency_ms;
    }

    upsert.run(
      group.hour,
      group.endpoint,
      group.method,
      group.total_requests,
      group.success_count,
      group.error_4xx,
      group.error_5xx,
      Math.round(group.avg_latency_ms * 100) / 100,
      Math.round(p95 * 100) / 100,
      group.agent_id,
    );
    rowsInserted++;
  }

  return rowsInserted;
}

/**
 * Purge raw request logs older than 24 hours.
 */
function purgeOldLogs(): number {
  const result = exec(
    `DELETE FROM api_request_logs WHERE timestamp < datetime('now', '-24 hours')`,
  );
  return result.changes;
}

/**
 * Main aggregation logic.
 */
async function run(): Promise<void> {
  const startMs = Date.now();

  // Find distinct hours in raw logs that haven't been aggregated yet
  // Focus on the previous hour to ensure we get complete data
  const hours = query<{ hour: string }>(
    `SELECT DISTINCT strftime('%Y-%m-%d %H:00', timestamp) as hour
     FROM api_request_logs
     WHERE strftime('%Y-%m-%d %H:00', timestamp) < strftime('%Y-%m-%d %H:00', 'now')
     ORDER BY hour`,
  );

  let totalRows = 0;
  for (const { hour } of hours) {
    totalRows += aggregateHour(hour);
  }

  const purged = purgeOldLogs();
  const durationMs = Date.now() - startMs;

  if (totalRows > 0 || purged > 0) {
    log.info('Metrics aggregation completed', {
      hoursProcessed: hours.length,
      groupsUpserted: totalRows,
      rawLogsPurged: purged,
      durationMs,
    });
  } else {
    log.debug('Metrics aggregation — nothing to process');
  }
}

/**
 * Register the api-metrics-aggregation task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('api-metrics-aggregation', async () => {
    await run();
  });
}
