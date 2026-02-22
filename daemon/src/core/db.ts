/**
 * SQLite database connection and typed query helpers.
 * WAL mode, single kithkit.db file, all state in one place.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { runMigrations } from './migrations.js';

let _db: Database.Database | null = null;

/**
 * Open (or create) the database, enable WAL mode, and run migrations.
 * @param projectDir - Project root directory (kithkit.db will be created here)
 * @param dbPath - Optional override for the database file path
 * @param migrationsDir - Optional override for migrations directory
 */
export function openDatabase(
  projectDir: string,
  dbPath?: string,
  migrationsDir?: string,
): Database.Database {
  if (_db) return _db;

  const resolvedPath = dbPath ?? path.join(projectDir, 'kithkit.db');
  _db = new Database(resolvedPath);

  // Enable WAL mode for concurrent reads
  _db.pragma('journal_mode = WAL');

  // Foreign keys on
  _db.pragma('foreign_keys = ON');

  // Run pending migrations
  runMigrations(_db, migrationsDir);

  return _db;
}

/**
 * Get the current database instance.
 * @throws if database hasn't been opened yet
 */
export function getDatabase(): Database.Database {
  if (!_db) throw new Error('Database not initialized — call openDatabase() first');
  return _db;
}

/**
 * Close the database connection.
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Typed query helpers ──────────────────────────────────────

/**
 * Insert a row and return it with auto-generated fields.
 */
export function insert<T>(
  table: string,
  data: Record<string, unknown>,
): T {
  const db = getDatabase();
  const keys = Object.keys(data);
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map(k => data[k]);

  const stmt = db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
  );
  const result = stmt.run(...values);

  // Return the full row
  const row = db.prepare(
    `SELECT * FROM ${table} WHERE rowid = ?`,
  ).get(result.lastInsertRowid);

  return row as T;
}

/**
 * Get a single row by primary key.
 */
export function get<T>(
  table: string,
  id: number | string,
  idColumn = 'id',
): T | undefined {
  const db = getDatabase();
  return db.prepare(
    `SELECT * FROM ${table} WHERE ${idColumn} = ?`,
  ).get(id) as T | undefined;
}

/**
 * List rows with optional filter.
 */
export function list<T>(
  table: string,
  filter?: Record<string, unknown>,
  orderBy?: string,
): T[] {
  const db = getDatabase();

  if (!filter || Object.keys(filter).length === 0) {
    const order = orderBy ? ` ORDER BY ${orderBy}` : '';
    return db.prepare(`SELECT * FROM ${table}${order}`).all() as T[];
  }

  const keys = Object.keys(filter);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  const values = keys.map(k => filter[k]);
  const order = orderBy ? ` ORDER BY ${orderBy}` : '';

  return db.prepare(
    `SELECT * FROM ${table} WHERE ${where}${order}`,
  ).all(...values) as T[];
}

/**
 * Update a row by primary key.
 */
export function update(
  table: string,
  id: number | string,
  data: Record<string, unknown>,
  idColumn = 'id',
): boolean {
  const db = getDatabase();
  const keys = Object.keys(data);
  const set = keys.map(k => `${k} = ?`).join(', ');
  const values = [...keys.map(k => data[k]), id];

  const result = db.prepare(
    `UPDATE ${table} SET ${set} WHERE ${idColumn} = ?`,
  ).run(...values);

  return result.changes > 0;
}

/**
 * Delete a row by primary key.
 */
export function remove(
  table: string,
  id: number | string,
  idColumn = 'id',
): boolean {
  const db = getDatabase();
  const result = db.prepare(
    `DELETE FROM ${table} WHERE ${idColumn} = ?`,
  ).run(id);
  return result.changes > 0;
}

/**
 * Run a raw SQL query with parameters.
 */
export function query<T>(sql: string, ...params: unknown[]): T[] {
  const db = getDatabase();
  return db.prepare(sql).all(...params) as T[];
}

/**
 * Run a raw SQL statement (INSERT/UPDATE/DELETE).
 */
export function exec(sql: string, ...params: unknown[]): Database.RunResult {
  const db = getDatabase();
  return db.prepare(sql).run(...params);
}

/** Reset for testing. */
export function _resetDbForTesting(): void {
  closeDatabase();
}
