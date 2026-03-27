/**
 * SQLite database connection and typed query helpers.
 * WAL mode, single kithkit.db file, all state in one place.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
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

// ── Identifier validation ────────────────────────────────────

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate a SQL identifier (table name, column name) to prevent injection.
 * Only allows alphanumeric characters and underscores.
 */
function validateIdentifier(name: string, context: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Invalid ${context}: "${name}" — must match [a-zA-Z_][a-zA-Z0-9_]*`);
  }
  return name;
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
  const safeTable = validateIdentifier(table, 'table name');
  const keys = Object.keys(data);
  keys.forEach(k => validateIdentifier(k, 'column name'));
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map(k => data[k]);

  const stmt = db.prepare(
    `INSERT INTO ${safeTable} (${keys.join(', ')}) VALUES (${placeholders})`,
  );
  const result = stmt.run(...values);

  // Return the full row
  const row = db.prepare(
    `SELECT * FROM ${safeTable} WHERE rowid = ?`,
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
  const safeTable = validateIdentifier(table, 'table name');
  const safeIdCol = validateIdentifier(idColumn, 'column name');
  return db.prepare(
    `SELECT * FROM ${safeTable} WHERE ${safeIdCol} = ?`,
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
  const safeTable = validateIdentifier(table, 'table name');

  // Validate orderBy — allow "column" or "column DESC/ASC"
  let order = '';
  if (orderBy) {
    const parts = orderBy.trim().split(/\s+/);
    validateIdentifier(parts[0]!, 'orderBy column');
    if (parts[1] && !/^(ASC|DESC)$/i.test(parts[1])) {
      throw new Error(`Invalid orderBy direction: "${parts[1]}"`);
    }
    order = ` ORDER BY ${parts[0]}${parts[1] ? ' ' + parts[1].toUpperCase() : ''}`;
  }

  if (!filter || Object.keys(filter).length === 0) {
    return db.prepare(`SELECT * FROM ${safeTable}${order}`).all() as T[];
  }

  const keys = Object.keys(filter);
  keys.forEach(k => validateIdentifier(k, 'filter column'));
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  const values = keys.map(k => filter[k]);

  return db.prepare(
    `SELECT * FROM ${safeTable} WHERE ${where}${order}`,
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
  const safeTable = validateIdentifier(table, 'table name');
  const safeIdCol = validateIdentifier(idColumn, 'column name');
  const keys = Object.keys(data);
  keys.forEach(k => validateIdentifier(k, 'column name'));
  const set = keys.map(k => `${k} = ?`).join(', ');
  const values = [...keys.map(k => data[k]), id];

  const result = db.prepare(
    `UPDATE ${safeTable} SET ${set} WHERE ${safeIdCol} = ?`,
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
  const safeTable = validateIdentifier(table, 'table name');
  const safeIdCol = validateIdentifier(idColumn, 'column name');
  const result = db.prepare(
    `DELETE FROM ${safeTable} WHERE ${safeIdCol} = ?`,
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

/**
 * Resolve the database file path from config or platform default.
 * Expands ~ to homedir. Creates parent directory if needed.
 *
 * Priority: configPath > platform default
 * Platform defaults:
 *   darwin → ~/Library/Application Support/kithkit/kithkit.db
 *   linux  → $XDG_DATA_HOME/kithkit/kithkit.db (fallback ~/.local/share/...)
 *   other  → ~/.kithkit/data/kithkit.db
 */
export function resolveDbPath(projectDir: string, configPath?: string): string {
  let resolved: string;

  if (configPath) {
    if (configPath.startsWith('~/')) {
      resolved = path.join(os.homedir(), configPath.slice(2));
    } else if (path.isAbsolute(configPath)) {
      resolved = configPath;
    } else {
      // Relative path — resolve against projectDir (backward compat)
      resolved = path.resolve(projectDir, configPath);
    }
  } else {
    // Platform default
    const home = os.homedir();
    if (process.platform === 'darwin') {
      resolved = path.join(home, 'Library', 'Application Support', 'kithkit', 'kithkit.db');
    } else if (process.platform === 'linux') {
      const xdgData = process.env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share');
      resolved = path.join(xdgData, 'kithkit', 'kithkit.db');
    } else {
      resolved = path.join(home, '.kithkit', 'data', 'kithkit.db');
    }
  }

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  return resolved;
}

/**
 * Migrate the legacy DB from projectDir/kithkit.db to newDbPath if needed.
 *
 * IMPORTANT: Call this BEFORE openDatabase() — opening the DB first holds a
 * WAL lock that prevents a clean backup.
 *
 * Migration steps:
 * 1. If old path doesn't exist or new path already exists → skip (log warning if both exist)
 * 2. Copy using better-sqlite3 backup() API (handles WAL correctly)
 * 3. Verify integrity with PRAGMA integrity_check
 * 4. Rename old .db, .db-wal, .db-shm to .migrated-backup variants
 *
 * Returns true if migration was performed, false otherwise.
 * On error: logs and returns false (caller continues with old path — no data loss).
 */
export async function migrateDbIfNeeded(
  projectDir: string,
  newDbPath: string,
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<boolean> {
  const oldPath = path.join(projectDir, 'kithkit.db');

  const oldExists = fs.existsSync(oldPath);
  const newExists = fs.existsSync(newDbPath);

  // Normalize: if paths resolve to the same file, nothing to do
  if (path.resolve(oldPath) === path.resolve(newDbPath)) {
    return false;
  }

  if (!oldExists) {
    return false; // Nothing to migrate
  }

  if (oldExists && newExists) {
    log.warn('Legacy kithkit.db found at project root — it is no longer used. You may delete it safely.', { path: oldPath });
    return false;
  }

  // oldExists && !newExists — perform migration
  log.info('Migrating database to new location...', { from: oldPath, to: newDbPath });

  let oldDb: Database.Database | null = null;
  let verifyDb: Database.Database | null = null;

  try {
    // Open old DB read-only for backup
    oldDb = new Database(oldPath, { readonly: true });

    // Copy using SQLite online backup API (safe for live WAL DBs)
    await oldDb.backup(newDbPath);
    oldDb.close();
    oldDb = null;

    // Verify integrity of the copy
    verifyDb = new Database(newDbPath, { readonly: true });
    const rows = verifyDb.pragma('integrity_check') as { integrity_check: string }[];
    verifyDb.close();
    verifyDb = null;

    const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok';
    if (!ok) {
      throw new Error(`integrity_check failed: ${JSON.stringify(rows)}`);
    }

    // Rename old files to .migrated-backup variants
    fs.renameSync(oldPath, `${oldPath}.migrated-backup`);
    for (const suffix of ['-wal', '-shm']) {
      const walPath = `${oldPath}${suffix}`;
      if (fs.existsSync(walPath)) {
        fs.renameSync(walPath, `${oldPath}.migrated-backup${suffix}`);
      }
    }

    log.info('Database migrated successfully. Legacy file kept as backup.', {
      from: oldPath,
      to: newDbPath,
      backup: `${oldPath}.migrated-backup`,
    });
    return true;

  } catch (err) {
    // Clean up handles
    try { oldDb?.close(); } catch { /* ignore */ }
    try { verifyDb?.close(); } catch { /* ignore */ }

    // If backup created a partial file at newDbPath, remove it to avoid confusion
    if (!newExists && fs.existsSync(newDbPath)) {
      try { fs.unlinkSync(newDbPath); } catch { /* ignore */ }
    }

    log.error('Database migration failed — continuing with existing location', {
      error: err instanceof Error ? err.message : String(err),
      oldPath,
      newPath: newDbPath,
    });
    return false;
  }
}

/** Reset for testing. */
export function _resetDbForTesting(): void {
  closeDatabase();
}
