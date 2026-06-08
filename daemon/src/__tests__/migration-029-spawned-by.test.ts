/**
 * Mutation-killing test for migration 029 (spawned_by / spawner_notified_at).
 *
 * Verifies that:
 *   1. A fresh DB (all migrations applied) has both columns.
 *   2. INSERT with spawned_by succeeds.
 *   3. SELECT on spawner_notified_at succeeds.
 *   4. The migration is idempotent on a DB that already has the columns
 *      (simulates the safe-alter path for existing installs).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, getMigrationsDir } from '../core/migrations.js';

let db: Database.Database;
let tmpDir: string;

describe('Migration 029: worker_jobs.spawned_by / spawner_notified_at', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-mig029-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db, getMigrationsDir());
  });

  after(() => {
    if (db?.open) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('worker_jobs.spawned_by column exists on fresh DB', () => {
    const cols = db.pragma('table_info(worker_jobs)') as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    assert.ok(names.includes('spawned_by'), `spawned_by column missing; columns: ${names.join(', ')}`);
  });

  it('worker_jobs.spawner_notified_at column exists on fresh DB', () => {
    const cols = db.pragma('table_info(worker_jobs)') as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    assert.ok(names.includes('spawner_notified_at'), `spawner_notified_at column missing; columns: ${names.join(', ')}`);
  });

  it('INSERT with spawned_by succeeds and is queryable', () => {
    const ts = new Date().toISOString();

    db.prepare(`
      INSERT INTO agents (id, type, profile, status, created_at, updated_at)
      VALUES ('ag-029-test', 'worker', 'coding', 'running', ?, ?)
    `).run(ts, ts);

    db.prepare(`
      INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, spawned_by, created_at)
      VALUES ('job-029-test', 'ag-029-test', 'coding', 'test task', 'running', 'comms', ?)
    `).run(ts);

    const row = db.prepare('SELECT spawned_by, spawner_notified_at FROM worker_jobs WHERE id = ?')
      .get('job-029-test') as { spawned_by: string | null; spawner_notified_at: string | null };

    assert.ok(row, 'row should exist');
    assert.equal(row.spawned_by, 'comms');
    assert.equal(row.spawner_notified_at, null);
  });

  it('UPDATE spawner_notified_at succeeds', () => {
    const now = new Date().toISOString();
    db.prepare('UPDATE worker_jobs SET spawner_notified_at = ? WHERE id = ?')
      .run(now, 'job-029-test');

    const row = db.prepare('SELECT spawner_notified_at FROM worker_jobs WHERE id = ?')
      .get('job-029-test') as { spawner_notified_at: string };

    assert.equal(row.spawner_notified_at, now);
  });

  it('migration 029 is safe to re-run (safe-alter idempotency)', () => {
    // Re-running the migration on a DB where the columns already exist must not throw.
    // The --safe-alter: directive in the runner catches "duplicate column name" errors.
    const migrationsDir = getMigrationsDir();
    // Remove the migration record so the runner would re-attempt it
    db.prepare('DELETE FROM migrations WHERE version = 29').run();
    // Should not throw
    assert.doesNotThrow(() => runMigrations(db, migrationsDir));
    // Confirm the columns are still there
    const cols = db.pragma('table_info(worker_jobs)') as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    assert.ok(names.includes('spawned_by'));
    assert.ok(names.includes('spawner_notified_at'));
  });
});
