/**
 * Metrics Sync task — push per-endpoint hourly metrics to BMO's ingest endpoint.
 *
 * Runs hourly. Reads the last 2 hours of aggregated metrics from the local
 * api_metrics_hourly table (per endpoint/method/hour), then POSTs them
 * to BMO's /api/metrics/ingest endpoint.
 *
 * Previous version generated an HTML dashboard and SCPed it to BMO.
 * Now uses the same direct-push approach as metrics-push for consistency.
 *
 * LAN-down tolerance: when curl cannot connect to BMO (client-isolation /
 * AP isolation on the LAN), the failure is logged at WARN and the task
 * returns cleanly.  Only genuine unexpected responses (connected but
 * unparseable body) remain at ERROR.
 */

import { execFile } from 'node:child_process';
import { query } from '../../../core/db.js';
import { createLogger } from '../../../core/logger.js';
import type { Scheduler } from '../../../automation/scheduler.js';

const log = createLogger('metrics-sync');

const BMO_HOST = '192.168.12.169';
const BMO_PORT = 3847;
const AGENT_NAME = 'skippy';

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
}

/**
 * Minimal logger interface — matches what createLogger returns.
 * Exported for test injection.
 */
export interface MetricsSyncLogger {
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Signals a connection-level curl failure (e.g. ECONNREFUSED, timeout, EHOSTUNREACH).
 * Distinct from a plain Error which means we DID connect but got a bad reply.
 */
class CurlConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurlConnectionError';
  }
}

/** Fetch per-endpoint hourly metrics from the local DB for the last N hours. */
function fetchLocalHourlyRows(hours: number): HourlyRow[] {
  return query<HourlyRow>(
    `SELECT
       hour, endpoint, method,
       total_requests, success_count,
       error_4xx, error_5xx,
       avg_latency_ms, p95_latency_ms
     FROM api_metrics_hourly
     WHERE hour >= strftime('%Y-%m-%d %H:00', datetime('now', ?))
     ORDER BY hour, endpoint, method`,
    `-${hours} hours`,
  );
}

type ExecFileFn = typeof execFile;
type FetchRowsFn = (hours: number) => HourlyRow[];

/** POST hourly metrics to BMO's ingest endpoint via curl. */
function pushToBmo(hourlyData: HourlyRow[], execFileFn: ExecFileFn = execFile): Promise<{ ingested: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      agent: AGENT_NAME,
      hourly: hourlyData,
    });

    execFileFn('curl', [
      '-s', '-X', 'POST',
      `http://${BMO_HOST}:${BMO_PORT}/api/metrics/ingest`,
      '-H', 'Content-Type: application/json',
      '-H', `X-Agent: ${AGENT_NAME}`,
      '--data-raw', payload,
      '--connect-timeout', '10',
      '--max-time', '30',
    ], { timeout: 35000 }, (err, stdout, stderr) => {
      if (err) {
        // curl exited non-zero — connection-level failure (ECONNREFUSED, timeout,
        // EHOSTUNREACH, etc.).  Wrap in CurlConnectionError so the caller can
        // distinguish this from a "connected but bad response" case.
        reject(new CurlConnectionError(`curl to BMO failed: ${stderr?.trim() || err.message}`));
        return;
      }
      try {
        const result = JSON.parse(stdout) as { ingested: number };
        resolve(result);
      } catch {
        // curl succeeded (exit 0) but BMO returned unparseable body — genuine error.
        reject(new Error(`Unexpected response from BMO: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function run(
  execFileFn: ExecFileFn = execFile,
  logger: MetricsSyncLogger = log,
  fetchRowsFn: FetchRowsFn = fetchLocalHourlyRows,
): Promise<void> {
  let rows: HourlyRow[];
  try {
    rows = fetchRowsFn(2);
  } catch (err) {
    logger.error('Failed to fetch local hourly metrics', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (rows.length === 0) {
    logger.info('No hourly metrics to push');
    return;
  }

  logger.info('Fetched per-endpoint hourly metrics', { rows: rows.length });

  try {
    const result = await pushToBmo(rows, execFileFn);
    logger.info('Metrics pushed to BMO', { ingested: result.ingested, rows: rows.length });
  } catch (err) {
    if (err instanceof CurlConnectionError) {
      // Connection-level failure — BMO box likely LAN-unreachable (client-isolation).
      // This is expected on APs with client isolation enabled.  Log at WARN and skip.
      logger.warn('Metrics push skipped — peer likely LAN-unreachable (client-isolation)', {
        error: err.message,
      });
    } else {
      // curl connected but got an unexpected response — genuine error worth alerting on.
      logger.error('Failed to push metrics to BMO — unexpected response', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('metrics-sync', async () => {
    await run();
  });
}

// ── Test hooks ────────────────────────────────────────────────
// Exported so tests can inject mock execFile, logger, and fetchRowsFn
// without module-level mocking.

export const _forTesting = {
  CurlConnectionError,
  pushToBmo,
  run,
};
