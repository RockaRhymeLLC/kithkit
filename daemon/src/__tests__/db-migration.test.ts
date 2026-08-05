/**
 * Tests for DB path resolution and migration logic.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
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

// ── resolveDbPath tests against the real implementation ──────
//
// These import the actual exported resolveDbPath/assertSafeDbPathConfig from
// core/db.ts (unlike the block above, which tests a local reimplementation
// of the pre-fix logic). os.homedir() is mocked to tmpDir for every case
// that touches the platform-default branch or "~" expansion, so these tests
// never create or read anything under the real
// ~/Library/Application Support/kithkit path.

describe('resolveDbPath (real implementation, fail-loud fallback)', () => {
  function makeLog() {
    const messages: { level: string; msg: string; meta?: Record<string, unknown> }[] = [];
    return {
      log: {
        info: (msg: string, meta?: Record<string, unknown>) => messages.push({ level: 'info', msg, meta }),
        warn: (msg: string, meta?: Record<string, unknown>) => messages.push({ level: 'warn', msg, meta }),
      },
      messages,
    };
  }

  it('with an explicit absolute configPath: unchanged behaviour', async () => {
    const { resolveDbPath } = await import('../core/db.js');
    const absPath = path.join(tmpDir, 'custom', 'data.db');
    const result = resolveDbPath(tmpDir, absPath);
    assert.equal(result, absPath);
    assert.ok(fs.existsSync(path.dirname(absPath)));
  });

  it('with an explicit relative configPath: resolves against projectDir, unchanged', async () => {
    const { resolveDbPath } = await import('../core/db.js');
    const result = resolveDbPath(tmpDir, 'data/kithkit.db');
    assert.equal(result, path.join(tmpDir, 'data', 'kithkit.db'));
  });

  it('with an explicit "~/" configPath: still expands against homedir, unchanged', async () => {
    const { resolveDbPath } = await import('../core/db.js');
    const homedirMock = mock.method(os, 'homedir', () => tmpDir);
    try {
      const result = resolveDbPath(tmpDir, '~/mydata/kithkit.db');
      assert.equal(result, path.join(tmpDir, 'mydata', 'kithkit.db'));
    } finally {
      homedirMock.mock.restore();
    }
  });

  it('with an explicit configPath: logs INFO (not WARN), confirming the configured path is distinguished', async () => {
    const { resolveDbPath } = await import('../core/db.js');
    const { log, messages } = makeLog();
    resolveDbPath(tmpDir, path.join(tmpDir, 'explicit.db'), log);
    assert.ok(messages.some(m => m.level === 'info'), 'Expected an info log for a configured db_path');
    assert.ok(!messages.some(m => m.level === 'warn'), 'Should not warn when db_path is configured');
  });

  it('with no configPath: still returns the platform default (deliberate feature preserved)', async () => {
    const { resolveDbPath } = await import('../core/db.js');
    const homedirMock = mock.method(os, 'homedir', () => tmpDir);
    try {
      const result = resolveDbPath(tmpDir);
      assert.ok(result.startsWith(tmpDir), `Expected path under mocked homedir ${tmpDir}, got: ${result}`);
      assert.ok(result.endsWith(path.join('kithkit', 'kithkit.db')), `Expected .../kithkit/kithkit.db, got: ${result}`);
    } finally {
      homedirMock.mock.restore();
    }
  });

  it('with no configPath: emits a WARN naming the resolved path and the reason (this is the fix)', async () => {
    const { resolveDbPath } = await import('../core/db.js');
    const homedirMock = mock.method(os, 'homedir', () => tmpDir);
    const { log, messages } = makeLog();
    try {
      const result = resolveDbPath(tmpDir, undefined, log);
      const warnMsg = messages.find(m => m.level === 'warn');
      assert.ok(warnMsg, 'Expected a WARN log when falling back to the platform default');
      assert.ok(!messages.some(m => m.level === 'info'), 'Should not log info on the fallback path');
      assert.equal(warnMsg?.meta?.['path'], result, 'WARN should carry the resolved fallback path in its metadata');
      assert.match(warnMsg!.msg, /no db_path configured/i, 'WARN message should state the reason, not just the path');
    } finally {
      homedirMock.mock.restore();
    }
  });
});

// ── assertSafeDbPathConfig — fail-closed startup guard ────────

describe('assertSafeDbPathConfig', () => {
  it('throws when an explicit project directory is given and db_path is unset (the dangerous combination)', async () => {
    const { assertSafeDbPathConfig, UnsafeDbPathConfigError } = await import('../core/db.js');
    assert.throws(
      () => assertSafeDbPathConfig({ explicitProjectDir: true, configPath: undefined }),
      UnsafeDbPathConfigError,
    );
  });

  it('does NOT throw when an explicit project directory is given but db_path IS set', async () => {
    const { assertSafeDbPathConfig } = await import('../core/db.js');
    assert.doesNotThrow(() =>
      assertSafeDbPathConfig({ explicitProjectDir: true, configPath: '/some/explicit/path.db' }),
    );
  });

  it('does NOT throw on a normal boot — no explicit project directory, db_path unset (narrowness test)', async () => {
    const { assertSafeDbPathConfig } = await import('../core/db.js');
    assert.doesNotThrow(() =>
      assertSafeDbPathConfig({ explicitProjectDir: false, configPath: undefined }),
    );
  });

  it('does NOT throw on a normal boot with db_path also set', async () => {
    const { assertSafeDbPathConfig } = await import('../core/db.js');
    assert.doesNotThrow(() =>
      assertSafeDbPathConfig({ explicitProjectDir: false, configPath: '/some/explicit/path.db' }),
    );
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
