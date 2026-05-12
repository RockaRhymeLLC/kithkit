/**
 * Calibration feed-forward — read the calibration log, compute a multiplier
 * hint per task_type, and produce a short string the orchestrator can prepend
 * to its spawn prompt so the model self-corrects on time-budgeting.
 *
 * Pairs with: scripts/calibration/stats.py (todo #488), POST /api/calibration/log
 * + auto-actual hook (todo #502). This is the final piece — closing the loop
 * from data → behavior.
 */

import { query } from '../core/db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('agents:calibration-hint');

const VALID_TASK_TYPES = new Set([
  'research', 'coding', 'data', 'report', 'docs', 'framework', 'comms', 'other', 'test',
]);

const MIN_SAMPLES = 3;   // Don't surface a hint without at least this many data points

interface CalibAggregateRow {
  n: number;
  avg_mult: number | null;
}

export interface CalibrationHint {
  hint: string;
  n: number;
  multiplier: number;       // mean of estimate_multiplier across the cohort
  taskType: string;         // 'overall' if no task-type-specific filter applied
}

/**
 * Compute a calibration hint from logged orch_task_calibrations.
 *
 * If `taskType` is provided + the cohort has ≥ MIN_SAMPLES rows with
 * actual_minutes IS NOT NULL, return a type-specific hint. If task-type
 * cohort is too small, fall back to overall mean. If overall is also too
 * small, return null.
 *
 * Errors are caught and logged — never thrown — so a calibration-table
 * problem never blocks orch escalation.
 */
export function getCalibrationHint(
  taskType?: string,
  _complexity?: string,
): CalibrationHint | null {
  try {
    const wantsType = taskType && VALID_TASK_TYPES.has(taskType) ? taskType : null;

    if (wantsType) {
      const rows = query<CalibAggregateRow>(
        `SELECT COUNT(*) AS n, AVG(estimate_multiplier) AS avg_mult
           FROM orch_task_calibrations
          WHERE task_type = ? AND actual_minutes IS NOT NULL AND estimate_multiplier IS NOT NULL`,
        wantsType,
      );
      const r = rows[0];
      if (r && r.n >= MIN_SAMPLES && r.avg_mult != null) {
        const mult = Math.round(r.avg_mult * 100) / 100;
        return {
          hint: formatHint(wantsType, r.n, mult),
          n: r.n,
          multiplier: mult,
          taskType: wantsType,
        };
      }
      // Fall through to overall if type cohort too small
    }

    // Overall fallback
    const overall = query<CalibAggregateRow>(
      `SELECT COUNT(*) AS n, AVG(estimate_multiplier) AS avg_mult
         FROM orch_task_calibrations
        WHERE actual_minutes IS NOT NULL AND estimate_multiplier IS NOT NULL`,
    );
    const o = overall[0];
    if (o && o.n >= MIN_SAMPLES && o.avg_mult != null) {
      const mult = Math.round(o.avg_mult * 100) / 100;
      return {
        hint: formatHint('overall', o.n, mult),
        n: o.n,
        multiplier: mult,
        taskType: 'overall',
      };
    }
    return null;
  } catch (err) {
    log.warn('getCalibrationHint failed (escalation not blocked)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function formatHint(taskType: string, n: number, multiplier: number): string {
  return `Calibration: similar ${taskType} tasks (n=${n}) ran at ${multiplier.toFixed(2)}× of stated time budget. Adjust your work pacing accordingly.`;
}

/**
 * Heuristic task_type classifier from description text. Mirrors the keyword
 * patterns used by scripts/calibration/back-fill.py so back-fill and
 * feed-forward agree on the type label per description.
 *
 * First match wins. Returns 'other' if no pattern matches.
 */
export function classifyTaskType(description: string): string {
  if (!description) return 'other';
  const text = description.toLowerCase();
  // Order matters — most specific first
  if (/\ba\/b\b|\bharness\b|\bframework\b|\bplaywright\b|test runner|test runner|migration|hook|endpoint|sqlite|attachment/.test(text)) return 'framework';
  if (/\bdigest\b|\breport\b|\bcsv\b|\bxlsx\b|aggregat|pivot|dashboard/.test(text)) return 'data';
  if (/\bspec\b|\bdesign doc\b|\bschema\b|\bdocument\b|\bblog\b|\breadme\b/.test(text)) return 'docs';
  if (/\bbuild\b|\bimplement\b|\bship\b|\brefactor\b|\bport\b|\bcomponent\b/.test(text)) return 'coding';
  if (/\bresearch\b|\bscoping\b|\bdiscover\b|\binvestigat\b|\baudit\b/.test(text)) return 'research';
  if (/\bemail\b|\btelegram\b|relay|notify|message/.test(text)) return 'comms';
  return 'other';
}
