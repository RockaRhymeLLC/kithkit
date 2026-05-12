/**
 * Calibration API — log gut-estimates at orch escalate-time so the calibration
 * tracking system (todo #488) can compute estimate-vs-actual without manual
 * back-fill. Companion: an auto-actual hook in api/task-queue.ts populates
 * actual_minutes when the orch task transitions to a terminal status.
 *
 * POST /api/calibration/log — insert (or upsert) a calibration row
 * GET  /api/calibration/log/:orch_task_id — fetch the row for a task (debug)
 */

import type http from 'node:http';
import { query, exec } from '../core/db.js';
import { createLogger } from '../core/logger.js';
import { json, withTimestamp, parseBody } from './helpers.js';

const log = createLogger('api:calibration');

const VALID_TASK_TYPES = new Set([
  'research', 'coding', 'data', 'report', 'docs', 'framework', 'comms', 'other', 'test',
]);
const VALID_COMPLEXITIES = new Set(['S', 'M', 'L', 'XL']);
const VALID_ESTIMATION_METHODS = new Set(['gut', 'scoping', 'comparable', 'none']);

interface CalibRow {
  id: number;
  orch_task_id: string | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
}

export async function handleCalibrationRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // POST /api/calibration/log — insert or upsert
  if (pathname === '/api/calibration/log' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await parseBody(req);
    } catch (err) {
      if (err instanceof Error && err.message === 'Invalid JSON') {
        json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
        return true;
      }
      throw err;
    }

    const orchTaskId = typeof body.orch_task_id === 'string' ? body.orch_task_id : null;
    const estimatedMinutes = typeof body.estimated_minutes === 'number'
      ? Math.round(body.estimated_minutes)
      : null;
    if (estimatedMinutes === null || estimatedMinutes < 0) {
      json(res, 400, withTimestamp({ error: 'estimated_minutes is required (positive integer)' }));
      return true;
    }

    const taskType = typeof body.task_type === 'string' && VALID_TASK_TYPES.has(body.task_type)
      ? body.task_type
      : 'other';
    const complexity = typeof body.complexity === 'string' && VALID_COMPLEXITIES.has(body.complexity)
      ? body.complexity
      : 'M';
    const estimationMethod = typeof body.estimation_method === 'string' && VALID_ESTIMATION_METHODS.has(body.estimation_method)
      ? body.estimation_method
      : 'gut';
    const notes = typeof body.notes === 'string' ? body.notes : null;
    const escalatedAt = new Date().toISOString();

    // Upsert: if orch_task_id provided + a row already exists, UPDATE the
    // estimate fields (actual_minutes left untouched — the close hook owns
    // it). Otherwise INSERT a new row.
    if (orchTaskId) {
      const existingRows = query<CalibRow>(
        'SELECT id, orch_task_id, estimated_minutes, actual_minutes FROM orch_task_calibrations WHERE orch_task_id = ? LIMIT 1',
        orchTaskId,
      );
      const existing = existingRows[0];
      if (existing) {
        exec(
          `UPDATE orch_task_calibrations
              SET estimated_minutes = ?, task_type = ?, complexity = ?, estimation_method = ?, notes = COALESCE(?, notes)
            WHERE id = ?`,
          estimatedMinutes, taskType, complexity, estimationMethod, notes, existing.id,
        );
        log.info('Calibration row updated', { id: existing.id, orch_task_id: orchTaskId });
        json(res, 200, withTimestamp({ id: existing.id, status: 'updated', message: 'Calibration estimate updated' }));
        return true;
      }
    }

    const result = exec(
      `INSERT INTO orch_task_calibrations
        (orch_task_id, escalated_at, estimated_minutes, task_type, complexity,
         workers_used, completion_status, estimation_method, notes)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      orchTaskId, escalatedAt, estimatedMinutes, taskType, complexity, estimationMethod, notes,
    );
    const id = (result as unknown as { lastInsertRowid: number | bigint }).lastInsertRowid;
    log.info('Calibration row inserted', { id: Number(id), orch_task_id: orchTaskId, estimatedMinutes, taskType });
    json(res, 201, withTimestamp({ id: Number(id), status: 'created', message: 'Calibration estimate logged' }));
    return true;
  }

  // GET /api/calibration/log/:orch_task_id — debug retrieval
  const getMatch = pathname.match(/^\/api\/calibration\/log\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    const orchTaskId = getMatch[1];
    const rows = query<Record<string, unknown>>(
      `SELECT * FROM orch_task_calibrations WHERE orch_task_id = ? LIMIT 1`,
      orchTaskId,
    );
    if (rows.length === 0) {
      json(res, 404, withTimestamp({ error: 'No calibration row for this orch_task_id' }));
      return true;
    }
    json(res, 200, withTimestamp({ row: rows[0] }));
    return true;
  }

  return false;
}

/**
 * Auto-actual hook — call from api/task-queue.ts when an orch task transitions
 * to a terminal status (completed / failed / cancelled / partial). Computes
 * actual_minutes from the calibration row's escalated_at (or the task's
 * started_at as fallback) → the supplied completedAt, and updates the row.
 *
 * Idempotent on actual_minutes: if already populated, this is a no-op.
 *
 * Errors are caught and logged — never thrown — so the orch task close path
 * stays unaffected by calibration bugs.
 */
export function recordCalibrationActual(
  orchTaskId: string,
  startedAt: string | null,
  completedAt: string,
  completionStatus: string,
): void {
  try {
    const rows = query<{ id: number; escalated_at: string | null; estimated_minutes: number | null; actual_minutes: number | null }>(
      `SELECT id, escalated_at, estimated_minutes, actual_minutes
         FROM orch_task_calibrations
        WHERE orch_task_id = ? LIMIT 1`,
      orchTaskId,
    );
    const row = rows[0];
    if (!row) return;                  // No estimate logged — nothing to update
    if (row.actual_minutes != null) return;  // Already filled (idempotent)

    const startIso = row.escalated_at ?? startedAt;
    if (!startIso) {
      log.debug('No start timestamp available for calibration auto-actual', { orchTaskId });
      return;
    }
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(completedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      log.warn('Invalid timestamps for calibration auto-actual', { orchTaskId, startIso, completedAt });
      return;
    }
    const actualMinutes = Math.max(0, Math.round((endMs - startMs) / 60000));
    const multiplier = (row.estimated_minutes && row.estimated_minutes > 0)
      ? actualMinutes / row.estimated_minutes
      : null;

    exec(
      `UPDATE orch_task_calibrations
          SET actual_minutes = ?, estimate_multiplier = ?, completion_status = ?
        WHERE id = ?`,
      actualMinutes, multiplier, completionStatus, row.id,
    );
    log.info('Calibration auto-actual recorded', {
      orchTaskId, actualMinutes, estimatedMinutes: row.estimated_minutes, multiplier,
    });
  } catch (err) {
    log.warn('recordCalibrationActual failed (orch close not blocked)', {
      orchTaskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
