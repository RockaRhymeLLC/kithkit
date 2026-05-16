/**
 * Tests for stale-todo-archive (#271)
 *
 * Verifies:
 * - Only matching (stale + prefix-filtered) todos are archived
 * - dry_run=false archives matching todos
 * - dry_run=true skips updates but still writes the log
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec, query } from '../core/db.js';
import { run } from '../automation/tasks/stale-todo-archive.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stale-todo-archive-test-'));
}

/** Format a date N days ago in SQLite datetime format (space separator, no timezone). */
function pastDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 3600_000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function seedTodo(title: string, status: string, updatedDaysAgo: number): number {
  const updatedAt = pastDate(updatedDaysAgo);
  const result = exec(
    `INSERT INTO todos (title, status, updated_at, created_at) VALUES (?, ?, ?, ?)`,
    title, status, updatedAt, updatedAt,
  );
  return result.lastInsertRowid as number;
}

describe('stale-todo-archive (t-271a)', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    logPath = path.join(tmpDir, 'logs', 'stale-todo-archive.log');
    _resetDbForTesting();
    openDatabase(tmpDir);
  });

  afterEach(() => {
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('archives exactly 2 matching todos (dry_run: false)', async () => {
    const id1 = seedTodo('FYI: maintenance window', 'pending', 30);   // SHOULD archive
    const id2 = seedTodo('Reminder: rotate keys', 'pending', 20);     // SHOULD archive
    seedTodo('Maintenance: deploy', 'pending', 5);                     // fresh — SHOULD NOT
    const id4 = seedTodo('FYI: ignore me', 'in_progress', 30);        // wrong status — SHOULD NOT
    seedTodo('Real work', 'pending', 30);                              // no prefix — SHOULD NOT

    await run({
      stale_days: 14,
      title_prefixes: ['FYI:', 'Reminder:', 'Maintenance:'],
      dry_run: false,
      log_path: logPath,
    });

    const done = query<{ id: number; status: string }>('SELECT id, status FROM todos WHERE status = ?', 'done');
    assert.equal(done.length, 2, 'exactly 2 todos should be archived');
    const doneIds = done.map(r => r.id);
    assert.ok(doneIds.includes(id1), 'FYI: maintenance window should be archived');
    assert.ok(doneIds.includes(id2), 'Reminder: rotate keys should be archived');

    // Remaining todos should be untouched
    const pending = query<{ id: number }>('SELECT id FROM todos WHERE status = ?', 'pending');
    const pendingIds = pending.map(r => r.id);
    assert.ok(!pendingIds.includes(id1), 'archived todo should not be pending');
    assert.ok(!pendingIds.includes(id2), 'archived todo should not be pending');

    const inProg = query<{ status: string }>('SELECT status FROM todos WHERE id = ?', id4);
    assert.equal(inProg[0]?.status, 'in_progress', 'in_progress todo should be unchanged');

    // Log should exist and record the archival
    assert.ok(fs.existsSync(logPath), 'log file should be created');
    const logContent = fs.readFileSync(logPath, 'utf-8');
    assert.ok(logContent.includes('count=2'), 'log should record count=2');
    assert.ok(logContent.includes('dry_run=false'), 'log should record dry_run=false');
  });

  it('dry_run: true — no updates, but log records expected count', async () => {
    seedTodo('FYI: maintenance window', 'pending', 30);
    seedTodo('Reminder: rotate keys', 'pending', 20);

    await run({
      stale_days: 14,
      title_prefixes: ['FYI:', 'Reminder:', 'Maintenance:'],
      dry_run: true,
      log_path: logPath,
    });

    // No todos should be moved to done
    const done = query<{ count: number }>('SELECT COUNT(*) as count FROM todos WHERE status = ?', 'done');
    assert.equal(done[0]?.count ?? 0, 0, 'dry_run should not archive any todos');

    // Log should still be written with the count
    assert.ok(fs.existsSync(logPath), 'log file should still be created in dry_run mode');
    const logContent = fs.readFileSync(logPath, 'utf-8');
    assert.ok(logContent.includes('count=2'), 'log should record count=2 even in dry_run');
    assert.ok(logContent.includes('dry_run=true'), 'log should record dry_run=true');
  });

  it('does not archive fresh todos (below stale_days threshold)', async () => {
    seedTodo('FYI: recent note', 'pending', 5);

    await run({
      stale_days: 14,
      title_prefixes: ['FYI:'],
      dry_run: false,
      log_path: logPath,
    });

    const done = query<{ count: number }>('SELECT COUNT(*) as count FROM todos WHERE status = ?', 'done');
    assert.equal(done[0]?.count ?? 0, 0, 'fresh todo should not be archived');

    const logContent = fs.readFileSync(logPath, 'utf-8');
    assert.ok(logContent.includes('count=0'), 'log should record count=0');
  });
});
