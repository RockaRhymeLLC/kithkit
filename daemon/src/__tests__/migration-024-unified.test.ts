/**
 * T4: Migration 024 integrity test.
 *
 * Strategy:
 *   1. Create a temp DB and apply migrations 001-023 (no 024).
 *   2. Insert seed rows into todos, todo_actions, orchestrator_tasks,
 *      orchestrator_task_activity, and orchestrator_task_workers.
 *   3. Apply migration 024 explicitly from the SQL file.
 *   4. Assert row counts match expectations.
 *   5. Assert new tables exist (tasks, task_activity, task_deps, task_calibration).
 *   6. Assert calendar.todo_ref was patched to the new task IDs.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runMigrations, getMigrationsDir } from '../core/migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to migrations directory (relative to compiled tests location)
function getMigrationsPath(): string {
  return getMigrationsDir();
}

// Create a temp migrations dir containing only migrations 001-023
function makePreMigrationDir(tmpDir: string): string {
  const preDir = path.join(tmpDir, 'migrations-pre024');
  fs.mkdirSync(preDir, { recursive: true });

  const srcDir = getMigrationsPath();
  const allFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of allFiles) {
    const match = file.match(/^(\d+)-/);
    if (!match) continue;
    const version = parseInt(match[1]!, 10);
    if (version < 24) {
      fs.copyFileSync(path.join(srcDir, file), path.join(preDir, file));
    }
  }

  return preDir;
}

describe('Migration 024: unified tasks table', { concurrency: 1 }, () => {
  let tmpDir: string;
  let db: Database.Database;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-mig024-'));
    const dbPath = path.join(tmpDir, 'test.db');

    // Step 1: Open DB with only migrations 001-023
    const preDir = makePreMigrationDir(tmpDir);
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db, preDir);

    // Step 2: Insert seed data into todos
    db.prepare(`
      INSERT INTO todos (title, description, priority, status, due_date, tags, created_at, updated_at)
      VALUES
        ('Todo Alpha', 'First todo', 'high', 'pending', NULL, '["urgent"]', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z'),
        ('Todo Beta',  'Second todo', 'medium', 'in_progress', '2026-06-01', '[]', '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z'),
        ('Todo Gamma', 'Done todo', 'low', 'done', NULL, '[]', '2026-01-03T10:00:00Z', '2026-01-03T10:00:00Z')
    `).run();

    // Insert todo_actions for todo id=1
    const todoId1 = (db.prepare('SELECT id FROM todos WHERE title = ?').get('Todo Alpha') as { id: number }).id;
    db.prepare(`
      INSERT INTO todo_actions (todo_id, action, old_value, new_value, note, created_at)
      VALUES
        (?, 'created', NULL, NULL, 'Created', '2026-01-01T10:00:01Z'),
        (?, 'status_changed', 'pending', 'in_progress', NULL, '2026-01-02T11:00:00Z')
    `).run(todoId1, todoId1);

    // Insert a calendar event referencing todo id=1 (to test todo_ref patch)
    db.prepare(`
      INSERT INTO calendar (title, start_time, todo_ref, created_at)
      VALUES ('Calendar event for alpha', '2026-06-15T09:00:00Z', ?, '2026-01-01T12:00:00Z')
    `).run(todoId1);

    // Step 3: Insert seed data into orchestrator_tasks
    db.prepare(`
      INSERT INTO orchestrator_tasks (id, title, description, status, assignee, priority, result, error,
        retry_count, outcome, outcome_notes, created_at, updated_at, assigned_at, started_at, completed_at)
      VALUES
        ('aaaaaaaa-bbbb-4000-8000-000000000001', 'Orch Task One', 'First orch task',
         'completed', 'orchestrator', 0, 'All done', NULL,
         0, 'success', NULL,
         '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z',
         '2026-01-10T10:05:00Z', '2026-01-10T10:10:00Z', '2026-01-10T12:00:00Z'),
        ('aaaaaaaa-bbbb-4000-8000-000000000002', 'Orch Task Two', 'Second orch task',
         'failed', 'orchestrator', 1, NULL, 'Worker crashed',
         1, 'failed', 'Timed out',
         '2026-01-11T10:00:00Z', '2026-01-11T11:00:00Z',
         '2026-01-11T10:05:00Z', '2026-01-11T10:10:00Z', '2026-01-11T11:00:00Z')
    `).run();

    // Insert orchestrator_task_activity
    db.prepare(`
      INSERT INTO orchestrator_task_activity (task_id, agent, type, stage, message, created_at)
      VALUES
        ('aaaaaaaa-bbbb-4000-8000-000000000001', 'orchestrator', 'progress', 'start', 'Task started', '2026-01-10T10:10:01Z'),
        ('aaaaaaaa-bbbb-4000-8000-000000000001', 'orchestrator', 'note', 'end', 'Task completed', '2026-01-10T12:00:01Z'),
        ('aaaaaaaa-bbbb-4000-8000-000000000002', 'orchestrator', 'progress', 'start', 'Task 2 started', '2026-01-11T10:10:01Z')
    `).run();

    // Insert a worker_jobs row and orchestrator_task_workers
    db.prepare(`
      INSERT INTO worker_jobs (id, profile, prompt, status, created_at)
      VALUES ('worker-job-001', 'coding', 'Do the work', 'completed', '2026-01-10T10:10:00Z')
    `).run();

    db.prepare(`
      INSERT INTO orchestrator_task_workers (task_id, worker_id, role, assigned_at)
      VALUES ('aaaaaaaa-bbbb-4000-8000-000000000001', 'worker-job-001', 'executor', '2026-01-10T10:10:00Z')
    `).run();

    // Step 4: Apply migration 024
    const migration024Path = path.join(getMigrationsPath(), '024-unified-tasks.sql');
    const sql024 = fs.readFileSync(migration024Path, 'utf-8');

    // Split and execute statements (better-sqlite3 requires exec for multi-statement)
    db.exec(sql024);

    // Record migration as applied
    db.prepare(`INSERT INTO migrations (version, name, applied_at) VALUES (24, 'unified-tasks', datetime('now'))`).run();
  });

  after(() => {
    if (db?.open) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tasks table exists', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as { name: string } | undefined;
    assert.ok(row, 'tasks table should exist');
  });

  it('task_activity table exists', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_activity'`).get() as { name: string } | undefined;
    assert.ok(row, 'task_activity table should exist');
  });

  it('task_deps table exists', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_deps'`).get() as { name: string } | undefined;
    assert.ok(row, 'task_deps table should exist');
  });

  it('task_calibration table exists', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_calibration'`).get() as { name: string } | undefined;
    assert.ok(row, 'task_calibration table should exist');
  });

  it('task_actions table exists', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_actions'`).get() as { name: string } | undefined;
    assert.ok(row, 'task_actions table should exist');
  });

  it('task_workers table exists', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_workers'`).get() as { name: string } | undefined;
    assert.ok(row, 'task_workers table should exist');
  });

  it('count of tasks WHERE kind=todo == count of original todos', () => {
    const todoCount = (db.prepare('SELECT COUNT(*) as cnt FROM todos').get() as { cnt: number }).cnt;
    const taskTodoCount = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE kind = 'todo'").get() as { cnt: number }).cnt;
    assert.equal(taskTodoCount, todoCount, `tasks(todo) count ${taskTodoCount} should equal todos count ${todoCount}`);
  });

  it('count of tasks WHERE kind=orchestrator == count of original orchestrator_tasks', () => {
    const orchCount = (db.prepare('SELECT COUNT(*) as cnt FROM orchestrator_tasks').get() as { cnt: number }).cnt;
    const taskOrchCount = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE kind = 'orchestrator'").get() as { cnt: number }).cnt;
    assert.equal(taskOrchCount, orchCount, `tasks(orch) count ${taskOrchCount} should equal orchestrator_tasks count ${orchCount}`);
  });

  it('count of task_actions == count of original todo_actions', () => {
    const todoActionCount = (db.prepare('SELECT COUNT(*) as cnt FROM todo_actions').get() as { cnt: number }).cnt;
    const taskActionCount = (db.prepare('SELECT COUNT(*) as cnt FROM task_actions').get() as { cnt: number }).cnt;
    assert.equal(taskActionCount, todoActionCount, `task_actions ${taskActionCount} should equal todo_actions ${todoActionCount}`);
  });

  it('count of task_activity == count of original orchestrator_task_activity', () => {
    const orchActivityCount = (db.prepare('SELECT COUNT(*) as cnt FROM orchestrator_task_activity').get() as { cnt: number }).cnt;
    const taskActivityCount = (db.prepare('SELECT COUNT(*) as cnt FROM task_activity').get() as { cnt: number }).cnt;
    assert.equal(taskActivityCount, orchActivityCount, `task_activity ${taskActivityCount} should equal orchestrator_task_activity ${orchActivityCount}`);
  });

  it('count of task_workers == count of original orchestrator_task_workers', () => {
    const orchWorkersCount = (db.prepare('SELECT COUNT(*) as cnt FROM orchestrator_task_workers').get() as { cnt: number }).cnt;
    const taskWorkersCount = (db.prepare('SELECT COUNT(*) as cnt FROM task_workers').get() as { cnt: number }).cnt;
    assert.equal(taskWorkersCount, orchWorkersCount, `task_workers ${taskWorkersCount} should equal orchestrator_task_workers ${orchWorkersCount}`);
  });

  it('calendar.todo_ref was updated to point to new task IDs (not old todo IDs)', () => {
    // The old todo id=1 was mapped to a new tasks row.
    // The calendar event's todo_ref should now point to the new tasks id, not the old todos id.
    const calRow = db.prepare(`
      SELECT c.todo_ref, t.kind, t.title
      FROM calendar c
      JOIN tasks t ON t.id = c.todo_ref
      WHERE c.title = 'Calendar event for alpha'
    `).get() as { todo_ref: number; kind: string; title: string } | undefined;

    assert.ok(calRow, 'calendar event should still exist with todo_ref pointing to tasks table');
    assert.equal(calRow.kind, 'todo', 'the referenced task should have kind=todo');
    assert.equal(calRow.title, 'Todo Alpha', 'the referenced task should be Todo Alpha');
  });

  it('todos with status=done were migrated as status=completed in tasks', () => {
    const doneRow = db.prepare(`
      SELECT status FROM tasks WHERE kind = 'todo' AND title = 'Todo Gamma'
    `).get() as { status: string } | undefined;

    assert.ok(doneRow, 'Todo Gamma should be in tasks table');
    assert.equal(doneRow.status, 'completed', "done status should be mapped to completed");
  });

  it('orchestrator task UUIDs are preserved as external_id in tasks', () => {
    const row = db.prepare(`
      SELECT external_id FROM tasks WHERE kind = 'orchestrator' AND title = 'Orch Task One'
    `).get() as { external_id: string } | undefined;

    assert.ok(row, 'Orch Task One should be in tasks table');
    assert.equal(row.external_id, 'aaaaaaaa-bbbb-4000-8000-000000000001');
  });

  it('old tables (todos, orchestrator_tasks) still exist for rollback safety', () => {
    const todosTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='todos'`).get();
    const orchTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='orchestrator_tasks'`).get();

    assert.ok(todosTable, 'todos table should still exist (rollback safety)');
    assert.ok(orchTable, 'orchestrator_tasks table should still exist (rollback safety)');
  });
});
