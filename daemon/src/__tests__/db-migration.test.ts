/**
 * Tests for DB path resolution and migration logic.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-db-migration-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── resolveDbPath tests ──────────────────────────────────────

describe('resolveDbPath', () => {
  // We test the logic in isolation by creating a local version
  function resolveDbPathLocal(projectDir: string, configPath?: string): string {
    let resolved: string;
    const home = os.homedir();
    if (configPath) {
      if (configPath.startsWith('~/')) {
        resolved = path.join(home, configPath.slice(2));
      } else if (path.isAbsolute(configPath)) {
        resolved = configPath;
      } else {
        resolved = path.resolve(projectDir, configPath);
      }
    } else {
      if (process.platform === 'darwin') {
        resolved = path.join(home, 'Library', 'Application Support', 'kithkit', 'kithkit.db');
      } else if (process.platform === 'linux') {
        const xdgData = process.env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share');
        resolved = path.join(xdgData, 'kithkit', 'kithkit.db');
      } else {
        resolved = path.join(home, '.kithkit', 'data', 'kithkit.db');
      }
    }
    // Create parent dir
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }

  it('expands ~ in configPath', () => {
    const result = resolveDbPathLocal(tmpDir, '~/mydata/kithkit.db');
    assert.equal(result, path.join(os.homedir(), 'mydata', 'kithkit.db'));
  });

  it('handles absolute configPath', () => {
    const absPath = path.join(tmpDir, 'custom', 'data.db');
    const result = resolveDbPathLocal(tmpDir, absPath);
    assert.equal(result, absPath);
  });

  it('resolves relative configPath against projectDir', () => {
    const result = resolveDbPathLocal(tmpDir, 'data/kithkit.db');
    assert.equal(result, path.join(tmpDir, 'data', 'kithkit.db'));
  });

  it('returns platform default when no configPath given', () => {
    const result = resolveDbPathLocal(tmpDir);
    assert.ok(result.endsWith('kithkit.db'), `Expected path ending in kithkit.db, got: ${result}`);
    assert.ok(result.includes('kithkit'), 'Expected path to include kithkit directory');
  });

  it('creates parent directory if needed', () => {
    const nestedPath = path.join(tmpDir, 'a', 'b', 'c', 'test.db');
    resolveDbPathLocal(tmpDir, nestedPath);
    assert.ok(fs.existsSync(path.dirname(nestedPath)), 'Parent directory should be created');
  });
});

// ── migrateDbIfNeeded tests ──────────────────────────────────

describe('migrateDbIfNeeded', () => {
  function makeLog() {
    const messages: { level: string; msg: string }[] = [];
    return {
      log: {
        info: (msg: string) => messages.push({ level: 'info', msg }),
        warn: (msg: string) => messages.push({ level: 'warn', msg }),
        error: (msg: string) => messages.push({ level: 'error', msg }),
      },
      messages,
    };
  }

  function createTestDb(dbPath: string): void {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO test VALUES (?, ?)').run(1, 'hello');
    db.close();
  }

  async function runMigration(projectDir: string, newDbPath: string) {
    const { migrateDbIfNeeded } = await import('../core/db.js');
    const { log, messages } = makeLog();
    const result = await migrateDbIfNeeded(projectDir, newDbPath, log);
    return { result, messages };
  }

  it('does nothing when old path does not exist', async () => {
    const newPath = path.join(tmpDir, 'new', 'kithkit.db');
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    const { result } = await runMigration(tmpDir, newPath);
    assert.equal(result, false);
    assert.ok(!fs.existsSync(newPath));
  });

  it('copies DB to new location when old exists and new does not', async () => {
    const oldPath = path.join(tmpDir, 'kithkit.db');
    createTestDb(oldPath);
    const newPath = path.join(tmpDir, 'new', 'kithkit.db');
    fs.mkdirSync(path.dirname(newPath), { recursive: true });

    const { result, messages } = await runMigration(tmpDir, newPath);
    assert.equal(result, true);
    assert.ok(fs.existsSync(newPath), 'New DB should exist');
    assert.ok(fs.existsSync(`${oldPath}.migrated-backup`), 'Old DB should be renamed to .migrated-backup');
    assert.ok(!fs.existsSync(oldPath), 'Old DB should no longer exist at original path');
    assert.ok(messages.some(m => m.level === 'info' && m.msg.includes('migrated successfully')));
  });

  it('verifies data integrity after migration', async () => {
    const oldPath = path.join(tmpDir, 'kithkit.db');
    createTestDb(oldPath);
    const newPath = path.join(tmpDir, 'new', 'kithkit.db');
    fs.mkdirSync(path.dirname(newPath), { recursive: true });

    await runMigration(tmpDir, newPath);

    // Verify data is intact in new DB
    const db = new Database(newPath, { readonly: true });
    const row = db.prepare('SELECT value FROM test WHERE id = 1').get() as { value: string };
    db.close();
    assert.equal(row.value, 'hello');
  });

  it('logs warning and skips when both old and new exist', async () => {
    const oldPath = path.join(tmpDir, 'kithkit.db');
    createTestDb(oldPath);
    const newPath = path.join(tmpDir, 'new', 'kithkit.db');
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    createTestDb(newPath);

    const { result, messages } = await runMigration(tmpDir, newPath);
    assert.equal(result, false);
    assert.ok(messages.some(m => m.level === 'warn' && m.msg.includes('no longer used')));
    // Neither file should be modified
    assert.ok(fs.existsSync(oldPath));
    assert.ok(fs.existsSync(newPath));
  });

  it('returns false when old and new paths are the same file', async () => {
    const oldPath = path.join(tmpDir, 'kithkit.db');
    createTestDb(oldPath);

    const { result } = await runMigration(tmpDir, oldPath);
    assert.equal(result, false);
  });

  it('also renames WAL and SHM files if present', async () => {
    const oldPath = path.join(tmpDir, 'kithkit.db');
    createTestDb(oldPath);
    // Create dummy WAL/SHM files
    fs.writeFileSync(`${oldPath}-wal`, 'dummy wal');
    fs.writeFileSync(`${oldPath}-shm`, 'dummy shm');

    const newPath = path.join(tmpDir, 'new', 'kithkit.db');
    fs.mkdirSync(path.dirname(newPath), { recursive: true });

    await runMigration(tmpDir, newPath);

    assert.ok(fs.existsSync(`${oldPath}.migrated-backup-wal`), 'WAL backup should exist');
    assert.ok(fs.existsSync(`${oldPath}.migrated-backup-shm`), 'SHM backup should exist');
    assert.ok(!fs.existsSync(`${oldPath}-wal`), 'WAL original should be gone');
    assert.ok(!fs.existsSync(`${oldPath}-shm`), 'SHM original should be gone');
  });
});
