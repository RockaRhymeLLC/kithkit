/**
 * Regression tests for scripts/check-migration-collisions.mjs
 *
 * Verifies that the lint script:
 *   - PASSES (exit 0) on a clean set of migration files with unique prefixes
 *   - FAILS  (exit 1) when a duplicate prefix is planted
 *
 * Uses temporary directories so no real migration files are touched.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'check-migration-collisions.mjs');

/** Run the lint script against a given migrations directory. */
function runLint(migrationsDir: string) {
  return spawnSync(process.execPath, [SCRIPT, '--migrations', migrationsDir], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

/** Write empty SQL fixture files into a directory. */
function touch(dir: string, ...filenames: string[]) {
  for (const f of filenames) {
    fs.writeFileSync(path.join(dir, f), '-- fixture\n');
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-mig-lint-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('check-migration-collisions lint', () => {
  it('passes (exit 0) on a clean set of unique-prefix migrations', () => {
    touch(
      tmpDir,
      '001-alpha.sql',
      '002-bravo.sql',
      '003-charlie.sql',
    );

    const result = runLint(tmpDir);

    assert.equal(
      result.status,
      0,
      `Expected exit 0 on clean set, got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(result.stdout, /OK/, 'Expected "OK" in stdout for clean set');
  });

  it('fails (exit 1) when a duplicate prefix is planted', () => {
    touch(
      tmpDir,
      '001-alpha.sql',
      '002-bravo.sql',   // clean
      '002-delta.sql',   // duplicate of 002 — planted collision
    );

    const result = runLint(tmpDir);

    assert.equal(
      result.status,
      1,
      `Expected exit 1 on duplicate prefix, got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(result.stderr, /FAIL/, 'Expected "FAIL" in stderr for duplicate');
    assert.match(result.stderr, /002/, 'Expected colliding prefix "002" in stderr');
    assert.match(result.stderr, /002-bravo\.sql/, 'Expected first file name in stderr');
    assert.match(result.stderr, /002-delta\.sql/, 'Expected second file name in stderr');
  });

  it('fails when multiple distinct prefixes collide', () => {
    touch(
      tmpDir,
      '001-alpha.sql',
      '001-echo.sql',    // dup of 001
      '003-gamma.sql',
      '003-hotel.sql',   // dup of 003
    );

    const result = runLint(tmpDir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /001/);
    assert.match(result.stderr, /003/);
  });

  it('ignores files that do not match the NNN-description.sql pattern', () => {
    touch(
      tmpDir,
      '001-alpha.sql',
      'README.md',
      'not-a-migration.sql',
      '002-bravo.sql',
    );

    const result = runLint(tmpDir);

    assert.equal(
      result.status,
      0,
      `Non-matching files should be ignored; got exit ${result.status}.\nstderr: ${result.stderr}`,
    );
  });

  it('passes on an empty migrations directory', () => {
    // tmpDir is empty
    const result = runLint(tmpDir);
    assert.equal(result.status, 0);
  });

  it('exits 2 when the migrations directory does not exist', () => {
    const result = runLint('/tmp/does-not-exist-kkit-mig-test');
    assert.equal(result.status, 2);
  });
});
