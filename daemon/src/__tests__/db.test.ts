/**
 * t-118, t-119, t-120, t-121: SQLite database + migrations tests
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  openDatabase,
  closeDatabase,
  getDatabase,
  insert,
  get,
  list,
  _resetDbForTesting,
} from '../core/db.js';
import {
  runMigrations,
  getCurrentVersion,
  getAppliedMigrations,
  discoverMigrations,
  getMigrationsDir,
} from '../core/migrations.js';

const EXPECTED_TABLES = [
  'agents',
  'worker_jobs',
  'memories',
  'todos',
  'todo_actions',
  'calendar',
  'messages',
  'config',
  'feature_state',
  'task_results',
  'migrations',
];

describe('Database schema (t-118)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetDbForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-db-'));
  });

  afterEach(() => {
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates kithkit.db automatically on first open', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    assert.ok(!fs.existsSync(dbPath), 'DB should not exist yet');

    openDatabase(tmpDir, dbPath, getMigrationsDir());
    assert.ok(fs.existsSync(dbPath), 'DB should be created');
  });

  it('creates all 11 tables with correct schema', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    const db = openDatabase(tmpDir, dbPath, getMigrationsDir());

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[];

    const tableNames = tables.map(t => t.name).sort();
    assert.deepEqual(tableNames, EXPECTED_TABLES.sort());
  });

  it('agents table has correct columns', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    const db = openDatabase(tmpDir, dbPath, getMigrationsDir());

    const columns = db.prepare("PRAGMA table_info('agents')").all() as { name: string; type: string }[];
    const colNames = columns.map(c => c.name);

    assert.ok(colNames.includes('id'));
    assert.ok(colNames.includes('type'));
    assert.ok(colNames.includes('profile'));
    assert.ok(colNames.includes('status'));
    assert.ok(colNames.includes('tmux_session'));
    assert.ok(colNames.includes('pid'));
    assert.ok(colNames.includes('state'));
    assert.ok(colNames.includes('created_at'));
    assert.ok(colNames.includes('updated_at'));
  });

  it('todos table has correct columns', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    const db = openDatabase(tmpDir, dbPath, getMigrationsDir());

    const columns = db.prepare("PRAGMA table_info('todos')").all() as { name: string }[];
    const colNames = columns.map(c => c.name);

    assert.ok(colNames.includes('id'));
    assert.ok(colNames.includes('title'));
    assert.ok(colNames.includes('description'));
    assert.ok(colNames.includes('priority'));
    assert.ok(colNames.includes('status'));
    assert.ok(colNames.includes('due_date'));
    assert.ok(colNames.includes('tags'));
  });

  it('messages table has processed_at column', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    const db = openDatabase(tmpDir, dbPath, getMigrationsDir());

    const columns = db.prepare("PRAGMA table_info('messages')").all() as { name: string }[];
    const colNames = columns.map(c => c.name);

    assert.ok(colNames.includes('processed_at'));
    assert.ok(colNames.includes('from_agent'));
    assert.ok(colNames.includes('to_agent'));
    assert.ok(colNames.includes('body'));
  });

  it('worker_jobs has foreign key to agents', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    const db = openDatabase(tmpDir, dbPath, getMigrationsDir());

    const fks = db.prepare("PRAGMA foreign_key_list('worker_jobs')").all() as { table: string; from: string }[];
    const agentFk = fks.find(fk => fk.table === 'agents');
    assert.ok(agentFk, 'worker_jobs should have FK to agents');
    assert.equal(agentFk!.from, 'agent_id');
  });
});

describe('Migrations (t-119)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetDbForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-mig-'));
  });

  afterEach(() => {
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all migrations applied after initial open', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    openDatabase(tmpDir, dbPath, getMigrationsDir());
    const db = getDatabase();

    const version = getCurrentVersion(db);
    assert.equal(version, 2);

    const applied = getAppliedMigrations(db);
    assert.equal(applied.length, 2);
    assert.equal(applied[0]!.version, 1);
    assert.equal(applied[0]!.name, 'initial-schema');
    assert.ok(applied[0]!.applied_at);
    assert.equal(applied[1]!.version, 2);
    assert.equal(applied[1]!.name, 'add-indexes');
    assert.ok(applied[1]!.applied_at);
  });

  it('new migration auto-applies on next open', () => {
    const migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);

    // Copy initial migration
    const srcMigrations = getMigrationsDir();
    fs.copyFileSync(
      path.join(srcMigrations, '001-initial-schema.sql'),
      path.join(migrationsDir, '001-initial-schema.sql'),
    );

    // First open
    const dbPath = path.join(tmpDir, 'kithkit.db');
    openDatabase(tmpDir, dbPath, migrationsDir);
    let db = getDatabase();
    assert.equal(getCurrentVersion(db), 1);

    // Close and add a new migration
    _resetDbForTesting();
    fs.writeFileSync(
      path.join(migrationsDir, '002-add-test-index.sql'),
      'CREATE INDEX idx_todos_status ON todos(status);',
    );

    // Second open — should auto-apply migration 2
    openDatabase(tmpDir, dbPath, migrationsDir);
    db = getDatabase();
    assert.equal(getCurrentVersion(db), 2);

    const applied = getAppliedMigrations(db);
    assert.equal(applied.length, 2);
    assert.equal(applied[1]!.name, 'add-test-index');
  });

  it('does not re-apply already applied migrations', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    openDatabase(tmpDir, dbPath, getMigrationsDir());
    let db = getDatabase();
    const firstApplied = getAppliedMigrations(db);

    // Close and reopen
    _resetDbForTesting();
    openDatabase(tmpDir, dbPath, getMigrationsDir());
    db = getDatabase();
    const secondApplied = getAppliedMigrations(db);

    assert.equal(firstApplied.length, secondApplied.length);
    assert.equal(secondApplied[0]!.applied_at, firstApplied[0]!.applied_at);
  });

  it('discovers migration files correctly', () => {
    const dir = getMigrationsDir();
    const migrations = discoverMigrations(dir);
    assert.ok(migrations.length >= 1);
    assert.equal(migrations[0]!.version, 1);
    assert.equal(migrations[0]!.name, 'initial-schema');
  });
});

describe('WAL mode (t-120)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetDbForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-wal-'));
  });

  afterEach(() => {
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('journal_mode is WAL', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    openDatabase(tmpDir, dbPath, getMigrationsDir());
    const db = getDatabase();

    const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(result.journal_mode, 'wal');
  });

  it('second connection can read while first writes', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    openDatabase(tmpDir, dbPath, getMigrationsDir());
    const db = getDatabase();

    // Insert some data
    db.prepare("INSERT INTO todos (title, priority, status) VALUES ('Test', 'high', 'pending')").run();

    // Open a second read connection
    const db2 = new Database(dbPath, { readonly: true });

    // Read from second connection while first is active
    const rows = db2.prepare('SELECT * FROM todos').all();
    assert.equal(rows.length, 1);

    db2.close();
  });

  it('WAL files exist alongside kithkit.db', () => {
    const dbPath = path.join(tmpDir, 'kithkit.db');
    openDatabase(tmpDir, dbPath, getMigrationsDir());
    const db = getDatabase();

    // Force WAL checkpoint by writing
    db.prepare("INSERT INTO config (key, value) VALUES ('test', '\"hello\"')").run();

    assert.ok(fs.existsSync(dbPath), 'kithkit.db should exist');
    assert.ok(fs.existsSync(`${dbPath}-wal`), 'kithkit.db-wal should exist');
    assert.ok(fs.existsSync(`${dbPath}-shm`), 'kithkit.db-shm should exist');
  });
});

describe('Typed query helpers (t-121)', () => {
  let tmpDir: string;

  interface TodoRow {
    id: number;
    title: string;
    description: string | null;
    priority: string;
    status: string;
    due_date: string | null;
    tags: string;
    created_at: string;
    updated_at: string;
  }

  beforeEach(() => {
    _resetDbForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-helpers-'));
    openDatabase(tmpDir, path.join(tmpDir, 'kithkit.db'), getMigrationsDir());
  });

  afterEach(() => {
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insert returns row with auto-generated id and timestamps', () => {
    const row = insert<TodoRow>('todos', { title: 'Test', priority: 'high' });

    assert.equal(typeof row.id, 'number');
    assert.ok(row.id > 0);
    assert.equal(row.title, 'Test');
    assert.equal(row.priority, 'high');
    assert.equal(row.status, 'pending'); // default
    assert.ok(row.created_at);
    assert.ok(row.updated_at);
  });

  it('get returns typed object by id', () => {
    const inserted = insert<TodoRow>('todos', { title: 'Get Test', priority: 'medium' });
    const found = get<TodoRow>('todos', inserted.id);

    assert.ok(found);
    assert.equal(found!.id, inserted.id);
    assert.equal(found!.title, 'Get Test');
    assert.equal(typeof found!.id, 'number');
    assert.equal(typeof found!.title, 'string');
  });

  it('get returns undefined for missing id', () => {
    const found = get<TodoRow>('todos', 999);
    assert.equal(found, undefined);
  });

  it('list returns all rows', () => {
    insert('todos', { title: 'A', priority: 'high' });
    insert('todos', { title: 'B', priority: 'low' });
    insert('todos', { title: 'C', priority: 'high' });

    const all = list<TodoRow>('todos');
    assert.equal(all.length, 3);
  });

  it('list with filter returns matching rows', () => {
    insert('todos', { title: 'A', priority: 'high' });
    insert('todos', { title: 'B', priority: 'low' });
    insert('todos', { title: 'C', priority: 'high' });

    const highPriority = list<TodoRow>('todos', { priority: 'high' });
    assert.equal(highPriority.length, 2);
    assert.ok(highPriority.every(t => t.priority === 'high'));
  });

  it('list with orderBy sorts results', () => {
    insert('todos', { title: 'B', priority: 'high' });
    insert('todos', { title: 'A', priority: 'low' });
    insert('todos', { title: 'C', priority: 'medium' });

    const ordered = list<TodoRow>('todos', undefined, 'title ASC');
    assert.equal(ordered[0]!.title, 'A');
    assert.equal(ordered[1]!.title, 'B');
    assert.equal(ordered[2]!.title, 'C');
  });
});
