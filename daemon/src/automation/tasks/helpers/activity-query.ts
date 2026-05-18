/**
 * Activity Query — composite real-work signal for the self-watchdog.
 *
 * Returns the MAX timestamp across five tables that represent meaningful
 * daemon work. Excludes scheduler tick logs and heartbeat-only activity.
 * Each table is queried independently so a missing table doesn't abort
 * the entire check (handles fresh installs and schema variations).
 */

import { query } from '../../../core/db.js';
import { createLogger } from '../../../core/logger.js';

const log = createLogger('self-watchdog:activity');

/**
 * Each source: table name and the timestamp column to MAX.
 * All five represent real work, not scheduler ticks or keepalives.
 */
const ACTIVITY_SOURCES: Array<{ table: string; col: string }> = [
  { table: 'worker_jobs',        col: 'finished_at'  },
  { table: 'tasks',              col: 'updated_at'   },
  { table: 'messages',           col: 'created_at'   },
  { table: 'memories',           col: 'created_at'   },
  { table: 'todos',              col: 'updated_at'   },
];

/**
 * Returns the latest real-work timestamp across all five activity sources,
 * as Unix ms. Returns null if no activity has ever been recorded.
 *
 * Handles missing tables gracefully — a missing table returns null for
 * that source and does not abort the overall query.
 */
export async function getLastActivityTimestamp(): Promise<number | null> {
  const candidates: number[] = [];

  for (const { table, col } of ACTIVITY_SOURCES) {
    try {
      const rows = query<{ ts: string | null }>(
        `SELECT MAX(${col}) as ts FROM ${table}`,
      );
      const ts = rows[0]?.ts;
      if (ts) {
        const ms = new Date(ts).getTime();
        if (!isNaN(ms)) {
          candidates.push(ms);
        }
      }
    } catch {
      log.debug('Activity source unavailable', { table, col });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  return Math.max(...candidates);
}
