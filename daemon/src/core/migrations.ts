/**
 * Schema migration system.
 * Reads .sql files from the migrations directory and applies them in order.
 * Tracks applied versions in the migrations table.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

/**
 * Get the migrations directory path.
 */
export function getMigrationsDir(): string {
  // In compiled output, migrations/ is a sibling of the compiled .js file
  // But .sql files aren't compiled, so we need to look in the source tree
  const srcMigrations = path.join(__dirname, 'migrations');
  if (fs.existsSync(srcMigrations)) return srcMigrations;

  // Fallback: check relative to project root
  const projectMigrations = path.resolve(__dirname, '..', '..', 'src', 'core', 'migrations');
  if (fs.existsSync(projectMigrations)) return projectMigrations;

  throw new Error(`Migrations directory not found (tried ${srcMigrations} and ${projectMigrations})`);
}

/**
 * Parse migration filename into version and name.
 * Format: NNN-name.sql (e.g., 001-initial-schema.sql)
 */
function parseMigrationFile(filename: string): { version: number; name: string } | null {
  const match = filename.match(/^(\d+)-(.+)\.sql$/);
  if (!match) return null;
  return {
    version: parseInt(match[1]!, 10),
    name: match[2]!,
  };
}

/**
 * Discover available migration files.
 */
export function discoverMigrations(migrationsDir: string): { version: number; name: string; path: string }[] {
  if (!fs.existsSync(migrationsDir)) return [];

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const migrations: { version: number; name: string; path: string }[] = [];
  for (const file of files) {
    const parsed = parseMigrationFile(file);
    if (parsed) {
      migrations.push({
        ...parsed,
        path: path.join(migrationsDir, file),
      });
    }
  }
  return migrations;
}

/**
 * Ensure the migrations table exists (bootstrap).
 */
function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Get the current schema version.
 */
export function getCurrentVersion(db: Database.Database): number {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) as version FROM migrations').get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

/**
 * Run all pending migrations.
 * Returns the number of migrations applied.
 */
export function runMigrations(db: Database.Database, migrationsDir?: string): number {
  const dir = migrationsDir ?? getMigrationsDir();
  ensureMigrationsTable(db);

  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map(r => r.version),
  );
  const available = discoverMigrations(dir);
  const pending = available.filter(m => !applied.has(m.version));

  if (pending.length === 0) return 0;

  // Sort by version to ensure order
  pending.sort((a, b) => a.version - b.version);

  const insertMigration = db.prepare(
    'INSERT INTO migrations (version, name) VALUES (?, ?)',
  );

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.path, 'utf8');

    // Run each migration in a transaction
    db.transaction(() => {
      // Handle --safe-alter: directives for idempotent ALTER TABLE ADD COLUMN.
      // SQLite lacks IF NOT EXISTS for ALTER TABLE, so these directives catch
      // "duplicate column name" errors gracefully — essential for migrations
      // that may run on both fresh installs and upgrades.
      const safeAlterLines: string[] = [];
      const regularSql: string[] = [];

      for (const line of sql.split('\n')) {
        const safeMatch = line.match(/^--safe-alter:\s*(.+)$/);
        if (safeMatch) {
          safeAlterLines.push(safeMatch[1]!.trim());
        } else {
          regularSql.push(line);
        }
      }

      // Execute regular SQL first
      const regularContent = regularSql.join('\n').trim();
      if (regularContent) {
        db.exec(regularContent);
      }

      // Execute safe ALTER TABLE statements, ignoring duplicate column errors
      for (const alter of safeAlterLines) {
        try {
          db.exec(`ALTER TABLE ${alter}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('duplicate column name')) {
            throw err;
          }
          // Column already exists — safe to skip
        }
      }

      insertMigration.run(migration.version, migration.name);
    })();
  }

  return pending.length;
}

/**
 * Get all applied migrations.
 */
export function getAppliedMigrations(db: Database.Database): MigrationRecord[] {
  ensureMigrationsTable(db);
  return db.prepare('SELECT version, name, applied_at FROM migrations ORDER BY version').all() as MigrationRecord[];
}
