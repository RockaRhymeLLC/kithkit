/**
 * Unified Task System v2.1 — Migration round-trip test (Q1-Q4).
 *
 * Verifies:
 *   1. Migration 019 applies cleanly to a fresh database.
 *   2. All new columns are present and accept values.
 *   3. CHECK constraint on complexity (S/M/L/XL) is enforced.
 *   4. CHECK constraint on comms_outcome is enforced.
 *   5. Sample row exercising all new columns can be inserted and read back.
 *   6. estimate_multiplier logic (application-layer computation, not a DB column).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../core/migrations.js';

let tmpDir: string;
let db: Database.Database;

function computeEstimateMultiplier(
  actual: number | null,
  estimated: number | null,
): number | null {
  if (actual == null || estimated == null || estimated === 0) return null;
  return actual / estimated;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-migration-v2.1-'));
  const dbPath = path.join(tmpDir, 'test.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Point at the source migrations directory
  const migrationsDir = path.resolve(import.meta.dirname, '../core/migrations');
  runMigrations(db, migrationsDir);
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 019 — unified-task-v2.1', () => {
  it('migration applied — version 19 present in migrations table', () => {
    const row = db.prepare('SELECT version FROM migrations WHERE version = 19').get() as { version: number } | undefined;
    assert.ok(row, 'Migration version 19 should be recorded');
    assert.equal(row?.version, 19);
  });

  it('all Q1 calibration columns exist on orchestrator_tasks', () => {
    const info = db.prepare("PRAGMA table_info('orchestrator_tasks')").all() as { name: string }[];
    const cols = new Set(info.map(c => c.name));
    for (const col of ['estimated_minutes', 'actual_minutes', 'task_type', 'complexity', 'completion_status', 'estimation_method', 'workers_used']) {
      assert.ok(cols.has(col), `Column ${col} should exist`);
    }
  });

  it('all Q2 dual-stage closure columns exist on orchestrator_tasks', () => {
    const info = db.prepare("PRAGMA table_info('orchestrator_tasks')").all() as { name: string }[];
    const cols = new Set(info.map(c => c.name));
    for (const col of ['generate_retro', 'acknowledged_at', 'comms_outcome', 'comms_corrections', 'source']) {
      assert.ok(cols.has(col), `Column ${col} should exist`);
    }
  });

  it('Q4 canonical_task_external_id column exists', () => {
    const info = db.prepare("PRAGMA table_info('orchestrator_tasks')").all() as { name: string }[];
    const cols = new Set(info.map(c => c.name));
    assert.ok(cols.has('canonical_task_external_id'), 'canonical_task_external_id should exist');
  });

  it('completed_at already existed (not re-added by 019)', () => {
    const info = db.prepare("PRAGMA table_info('orchestrator_tasks')").all() as { name: string }[];
    const cols = new Set(info.map(c => c.name));
    assert.ok(cols.has('completed_at'), 'completed_at should still exist from 008');
  });

  it('can insert a sample row exercising all new columns and read it back', () => {
    const id = 'test-row-v2.1';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO orchestrator_tasks
        (id, title, status, priority, created_at, updated_at,
         estimated_minutes, actual_minutes, task_type, complexity,
         completion_status, estimation_method, workers_used,
         generate_retro, acknowledged_at, comms_outcome, comms_corrections,
         source, canonical_task_external_id)
      VALUES
        (?, 'v2.1 test task', 'completed', 0, ?, ?,
         30, 45, 'feature', 'M',
         'success', 'historical', 2,
         1, ?, 'corrected', '{"field":"value"}',
         'human', 'abc123def456abc123def456abc123de')
    `).run(id, now, now, now);

    const row = db.prepare('SELECT * FROM orchestrator_tasks WHERE id = ?').get(id) as Record<string, unknown>;
    assert.ok(row, 'Inserted row should be retrievable');
    assert.equal(row['estimated_minutes'], 30);
    assert.equal(row['actual_minutes'], 45);
    assert.equal(row['task_type'], 'feature');
    assert.equal(row['complexity'], 'M');
    assert.equal(row['completion_status'], 'success');
    assert.equal(row['estimation_method'], 'historical');
    assert.equal(row['workers_used'], 2);
    assert.equal(row['generate_retro'], 1);
    assert.ok(row['acknowledged_at'], 'acknowledged_at should be set');
    assert.equal(row['comms_outcome'], 'corrected');
    assert.equal(row['comms_corrections'], '{"field":"value"}');
    assert.equal(row['source'], 'human');
    assert.equal(row['canonical_task_external_id'], 'abc123def456abc123def456abc123de');
  });

  it('estimate_multiplier computed correctly on read (application-layer)', () => {
    // actual=45, estimated=30 → multiplier=1.5
    assert.equal(computeEstimateMultiplier(45, 30), 1.5);
    // null inputs → null
    assert.equal(computeEstimateMultiplier(null, 30), null);
    assert.equal(computeEstimateMultiplier(45, null), null);
    // zero estimated → null (avoid division by zero)
    assert.equal(computeEstimateMultiplier(45, 0), null);
  });

  it('complexity CHECK constraint rejects invalid values', () => {
    const id = 'bad-complexity-row';
    const now = new Date().toISOString();
    assert.throws(() => {
      db.prepare(`
        INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at, complexity)
        VALUES (?, 'bad', 'pending', 0, ?, ?, 'INVALID')
      `).run(id, now, now);
    }, (err: Error) => err.message.includes('CHECK constraint') || err.message.includes('CONSTRAINT'));
  });

  it('complexity CHECK constraint accepts all valid values and NULL', () => {
    const now = new Date().toISOString();
    for (const [idx, val] of ['S', 'M', 'L', 'XL', null].entries()) {
      const id = `complexity-ok-${idx}`;
      assert.doesNotThrow(() => {
        db.prepare(`
          INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at, complexity)
          VALUES (?, 'ok', 'pending', 0, ?, ?, ?)
        `).run(id, now, now, val);
      }, `Should accept complexity value: ${String(val)}`);
    }
  });

  it('comms_outcome CHECK constraint rejects invalid values', () => {
    const id = 'bad-outcome-row';
    const now = new Date().toISOString();
    assert.throws(() => {
      db.prepare(`
        INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at, comms_outcome)
        VALUES (?, 'bad', 'pending', 0, ?, ?, 'invalid_outcome')
      `).run(id, now, now);
    }, (err: Error) => err.message.includes('CHECK constraint') || err.message.includes('CONSTRAINT'));
  });

  it('comms_outcome CHECK constraint accepts all valid values and NULL', () => {
    const now = new Date().toISOString();
    for (const [idx, val] of ['corrected', 'redirected', 'accepted', 'cancelled', null].entries()) {
      const id = `outcome-ok-${idx}`;
      assert.doesNotThrow(() => {
        db.prepare(`
          INSERT INTO orchestrator_tasks (id, title, status, priority, created_at, updated_at, comms_outcome)
          VALUES (?, 'ok', 'pending', 0, ?, ?, ?)
        `).run(id, now, now, val);
      }, `Should accept comms_outcome value: ${String(val)}`);
    }
  });

  it('migration is idempotent — running again does not fail', () => {
    // The --safe-alter directives handle "duplicate column name" gracefully.
    // Running runMigrations again on the same DB should be a no-op.
    const migrationsDir = path.resolve(import.meta.dirname, '../core/migrations');
    assert.doesNotThrow(() => {
      runMigrations(db, migrationsDir);
    }, 'runMigrations should be idempotent');
  });
});
