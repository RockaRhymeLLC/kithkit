/**
 * Tests for bootstrapCommsToken() and assertCommsTokenReady() — kkit#388.
 *
 * Covers:
 *  1. Minter creates .comms-token when file is absent (file created, mode 0600, verifyToken passes).
 *  2. Minter is idempotent — second call with a valid token does NOT re-mint.
 *  3. assertCommsTokenReady throws when token file is absent (guard fires — catches missing minter).
 *  4. assertCommsTokenReady throws when token file contains an invalid token (guard fires).
 *
 * Tests 3 and 4 are the regression sentinels: removing bootstrapCommsToken() or gutting it
 * leaves the token file absent, causing test 1 to fail RED. Tests 3/4 additionally ensure
 * the guard itself is exercised so removing assertCommsTokenReady also trips a RED test.
 *
 * IMPORTANT: assertCommsTokenReady() detects the test runner via isUnderTestRunner() and
 * throws instead of calling process.exit(1), so these tests are safe to run in any CI/CD.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../core/db.js';
import { verifyToken } from '../auth/agent-tokens.js';
import { bootstrapCommsToken, assertCommsTokenReady } from '../auth/comms-token.js';

// Silent logger — suppresses output noise during tests
const noopLog = {
  info: (_msg: string, _data?: Record<string, unknown>) => {},
  warn: (_msg: string, _data?: Record<string, unknown>) => {},
  error: (_msg: string, _data?: Record<string, unknown>) => {},
};

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-commstoken-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  _resetDbForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 1. Mints token when absent ────────────────────────────────────────────────

describe('bootstrapCommsToken: mints token when file is absent', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('creates .kithkit/.comms-token with mode 0600 and a valid comms token', () => {
    const tokenPath = path.join(tmpDir, '.kithkit', '.comms-token');
    assert.ok(!fs.existsSync(tokenPath), 'Precondition: token file must not exist');

    bootstrapCommsToken(tmpDir, noopLog);

    assert.ok(fs.existsSync(tokenPath), 'Token file should be created by bootstrapCommsToken');

    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    assert.ok(token.length > 0, 'Token should be non-empty');

    // Token must be in the DB and pass verifyToken with role=comms
    const identity = verifyToken(token);
    assert.ok(identity !== null, 'verifyToken should return a non-null identity');
    assert.equal(identity.role, 'comms', 'Token role should be comms');
    assert.equal(identity.jobId, null, 'Token jobId should be null for comms role');

    // File permissions must be 0600
    const stat = fs.statSync(tokenPath);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `Token file mode should be 0o600, got 0o${mode.toString(8)}`);
  });
});

// ── 2. Idempotent on second call ──────────────────────────────────────────────

describe('bootstrapCommsToken: idempotent when valid token already exists', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('does not re-mint or modify the token when called a second time with valid token', () => {
    // First call — mints the token
    bootstrapCommsToken(tmpDir, noopLog);

    const tokenPath = path.join(tmpDir, '.kithkit', '.comms-token');
    const firstToken = fs.readFileSync(tokenPath, 'utf8').trim();
    assert.ok(verifyToken(firstToken) !== null, 'Precondition: first token should be valid');

    // Second call — must return early, leaving the same token in place
    bootstrapCommsToken(tmpDir, noopLog);

    const secondToken = fs.readFileSync(tokenPath, 'utf8').trim();
    assert.equal(firstToken, secondToken, 'Token file contents must not change on second bootstrap call');
  });
});

// ── 3 & 4. assertCommsTokenReady fail-loud guard ──────────────────────────────
//
// Because tests run under node --test (NODE_TEST_CONTEXT is set), assertCommsTokenReady
// throws instead of calling process.exit(1). This makes the guard safely exercisable
// in the test suite without killing the process.

describe('assertCommsTokenReady: fail-loud guard fires on bad token state', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('throws when .comms-token file is absent (catches a missing minter)', () => {
    const missingPath = path.join(tmpDir, '.kithkit', '.comms-token-nonexistent');
    assert.ok(!fs.existsSync(missingPath), 'Precondition: path must not exist');

    assert.throws(
      () => assertCommsTokenReady(missingPath, noopLog),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'Should throw an Error');
        assert.ok(
          err.message.includes('FATAL: comms token not ready'),
          `Error message should contain "FATAL: comms token not ready", got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('throws when .comms-token contains a token not present in the database', () => {
    // Write a syntactically valid-looking but unregistered token to the file
    const tokenDir = path.join(tmpDir, '.kithkit');
    fs.mkdirSync(tokenDir, { recursive: true });
    const tokenPath = path.join(tokenDir, '.comms-token');
    // 64 hex chars — looks like a real token but is not in the agent_tokens table
    fs.writeFileSync(tokenPath, 'deadbeef'.repeat(8), { mode: 0o600 });

    assert.ok(verifyToken('deadbeef'.repeat(8)) === null, 'Precondition: garbage token must not verify');

    assert.throws(
      () => assertCommsTokenReady(tokenPath, noopLog),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'Should throw an Error');
        assert.ok(
          err.message.includes('FATAL: comms token not ready'),
          `Error message should contain "FATAL: comms token not ready", got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
