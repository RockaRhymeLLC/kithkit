/**
 * Tests for the calibration API + auto-actual hook.
 *
 * Covers:
 *   POST /api/calibration/log — insert + idempotent upsert on orch_task_id
 *   GET  /api/calibration/log/:orch_task_id — debug retrieval
 *   recordCalibrationActual() — auto-actual computation from started_at -> completed_at
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec, query, getDatabase } from '../../core/db.js';
import { handleCalibrationRoute, recordCalibrationActual } from '../calibration.js';

let server: http.Server;
let serverUrl: string;

async function setup(): Promise<void> {
  _resetDbForTesting();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Apply the calibration migration (multi-statement; use raw DB exec)
  const migration = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/migrations/calibration-log.sql'),
    'utf8',
  );
  getDatabase().exec(migration);

  // HTTP server
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const handled = await handleCalibrationRoute(req, res, url.pathname);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address();
  if (typeof addr === 'object' && addr) serverUrl = `http://127.0.0.1:${addr.port}`;
}

async function teardown(): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const opts: http.RequestOptions = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(`${serverUrl}${path}`, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(text); } catch { /* tolerated */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('POST /api/calibration/log', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('creates a row with explicit orch_task_id (201)', async () => {
    const res = await request('POST', '/api/calibration/log', {
      orch_task_id: 'task-abc',
      estimated_minutes: 60,
      task_type: 'framework',
      complexity: 'M',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'created');
    assert.equal(typeof res.body.id, 'number');
  });

  it('is idempotent on orch_task_id (UPDATE on second call)', async () => {
    const first = await request('POST', '/api/calibration/log', {
      orch_task_id: 'task-xyz',
      estimated_minutes: 30,
      task_type: 'docs',
    });
    assert.equal(first.body.status, 'created');

    const second = await request('POST', '/api/calibration/log', {
      orch_task_id: 'task-xyz',
      estimated_minutes: 45,
      task_type: 'docs',
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'updated');
    assert.equal(second.body.id, first.body.id);

    const rows = query<{ estimated_minutes: number }>(
      `SELECT estimated_minutes FROM orch_task_calibrations WHERE orch_task_id = ?`,
      'task-xyz',
    );
    assert.equal(rows[0].estimated_minutes, 45);
  });

  it('rejects missing estimated_minutes (400)', async () => {
    const res = await request('POST', '/api/calibration/log', { task_type: 'data' });
    assert.equal(res.status, 400);
  });

  it('coerces invalid task_type to "other"', async () => {
    await request('POST', '/api/calibration/log', {
      orch_task_id: 'task-coerce',
      estimated_minutes: 10,
      task_type: 'not-a-real-type',
    });
    const rows = query<{ task_type: string }>(
      `SELECT task_type FROM orch_task_calibrations WHERE orch_task_id = ?`,
      'task-coerce',
    );
    assert.equal(rows[0].task_type, 'other');
  });

  it('accepts request with no orch_task_id (anonymous baseline insert)', async () => {
    const res = await request('POST', '/api/calibration/log', {
      estimated_minutes: 90,
      task_type: 'coding',
      notes: 'baseline-row',
    });
    assert.equal(res.status, 201);
    const rows = query<{ orch_task_id: string | null; notes: string }>(
      `SELECT orch_task_id, notes FROM orch_task_calibrations WHERE notes = 'baseline-row'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orch_task_id, null);
  });
});

describe('GET /api/calibration/log/:orch_task_id', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns the row when present (200)', async () => {
    await request('POST', '/api/calibration/log', {
      orch_task_id: 'task-get',
      estimated_minutes: 25,
      task_type: 'research',
    });
    const res = await request('GET', '/api/calibration/log/task-get');
    assert.equal(res.status, 200);
    const row = res.body.row as Record<string, unknown>;
    assert.equal(row.orch_task_id, 'task-get');
    assert.equal(row.estimated_minutes, 25);
  });

  it('returns 404 when no row exists', async () => {
    const res = await request('GET', '/api/calibration/log/never-existed');
    assert.equal(res.status, 404);
  });
});

describe('recordCalibrationActual()', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('computes actual_minutes + multiplier from escalated_at to completed_at', async () => {
    await request('POST', '/api/calibration/log', {
      orch_task_id: 'task-actual',
      estimated_minutes: 60,
      task_type: 'framework',
    });
    // Manually backdate escalated_at by 10 minutes
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    exec(`UPDATE orch_task_calibrations SET escalated_at = ? WHERE orch_task_id = ?`, tenMinAgo, 'task-actual');

    recordCalibrationActual('task-actual', null, new Date().toISOString(), 'completed');

    const rows = query<{ actual_minutes: number; estimate_multiplier: number; completion_status: string }>(
      `SELECT actual_minutes, estimate_multiplier, completion_status FROM orch_task_calibrations WHERE orch_task_id = ?`,
      'task-actual',
    );
    assert.ok(Math.abs(rows[0].actual_minutes - 10) <= 1, `expected ~10, got ${rows[0].actual_minutes}`);
    assert.ok(Math.abs(rows[0].estimate_multiplier - 0.1667) < 0.05, `expected ~0.17, got ${rows[0].estimate_multiplier}`);
    assert.equal(rows[0].completion_status, 'completed');
  });

  it('is a no-op when no calibration row exists for the task', () => {
    // Nothing logged for 'task-missing' — should not throw or fail
    recordCalibrationActual('task-missing', null, new Date().toISOString(), 'completed');
    const rows = query(`SELECT * FROM orch_task_calibrations WHERE orch_task_id = ?`, 'task-missing');
    assert.equal(rows.length, 0);
  });

  it('is idempotent — does not overwrite an already-set actual_minutes', async () => {
    await request('POST', '/api/calibration/log', {
      orch_task_id: 'task-idem',
      estimated_minutes: 30,
      task_type: 'docs',
    });
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    exec(`UPDATE orch_task_calibrations SET escalated_at = ? WHERE orch_task_id = ?`, past, 'task-idem');

    recordCalibrationActual('task-idem', null, new Date().toISOString(), 'completed');
    const first = query<{ actual_minutes: number }>(
      `SELECT actual_minutes FROM orch_task_calibrations WHERE orch_task_id = ?`,
      'task-idem',
    )[0].actual_minutes;

    // Second call with a much later completed_at should NOT change actual_minutes
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    recordCalibrationActual('task-idem', null, later, 'completed');
    const second = query<{ actual_minutes: number }>(
      `SELECT actual_minutes FROM orch_task_calibrations WHERE orch_task_id = ?`,
      'task-idem',
    )[0].actual_minutes;

    assert.equal(second, first);
  });
});
