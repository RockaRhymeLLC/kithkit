/**
 * Agent token auth unit tests.
 *
 * Covers: issue → verify roundtrip for each role, revoke, garbage token.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../core/db.js';
import { issueToken, verifyToken, revokeToken, revokeTokensByJobId } from '../auth/agent-tokens.js';

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-tokens-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  _resetDbForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('agent-tokens: issue → verify roundtrip', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('comms token verifies with correct role', () => {
    const token = issueToken('comms');
    assert.ok(token.length > 0);

    const identity = verifyToken(token);
    assert.ok(identity !== null);
    assert.equal(identity.role, 'comms');
    assert.equal(identity.jobId, null);
  });

  it('orchestrator token verifies with correct role', () => {
    const token = issueToken('orchestrator');
    const identity = verifyToken(token);
    assert.ok(identity !== null);
    assert.equal(identity.role, 'orchestrator');
    assert.equal(identity.jobId, null);
  });

  it('worker token verifies with correct role and jobId', () => {
    const token = issueToken('worker', { jobId: 'job-abc-123' });
    const identity = verifyToken(token);
    assert.ok(identity !== null);
    assert.equal(identity.role, 'worker');
    assert.equal(identity.jobId, 'job-abc-123');
  });

  it('worker token without jobId has null jobId', () => {
    const token = issueToken('worker');
    const identity = verifyToken(token);
    assert.ok(identity !== null);
    assert.equal(identity.role, 'worker');
    assert.equal(identity.jobId, null);
  });

  it('two issued tokens are distinct', () => {
    const t1 = issueToken('comms');
    const t2 = issueToken('comms');
    assert.notEqual(t1, t2);
  });
});

describe('agent-tokens: revoke by token', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('verify returns null after revoke', () => {
    const token = issueToken('comms');
    assert.ok(verifyToken(token) !== null);

    revokeToken(token);
    assert.equal(verifyToken(token), null);
  });

  it('revoking a nonexistent token is a no-op', () => {
    // Should not throw
    assert.doesNotThrow(() => revokeToken('does-not-exist-1234'));
  });

  it('revoking already-revoked token is a no-op', () => {
    const token = issueToken('worker');
    revokeToken(token);
    // Second revoke should not throw
    assert.doesNotThrow(() => revokeToken(token));
    assert.equal(verifyToken(token), null);
  });
});

describe('agent-tokens: revokeTokensByJobId', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('revokes all active tokens for a job', () => {
    const t1 = issueToken('worker', { jobId: 'job-xyz' });
    const t2 = issueToken('worker', { jobId: 'job-xyz' });

    revokeTokensByJobId('job-xyz');

    assert.equal(verifyToken(t1), null);
    assert.equal(verifyToken(t2), null);
  });

  it('does not revoke tokens from a different job', () => {
    const other = issueToken('worker', { jobId: 'other-job' });
    issueToken('worker', { jobId: 'job-to-revoke' });

    revokeTokensByJobId('job-to-revoke');

    assert.ok(verifyToken(other) !== null);
  });

  it('no-op when job has no tokens', () => {
    assert.doesNotThrow(() => revokeTokensByJobId('nonexistent-job'));
  });
});

describe('agent-tokens: garbage token', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('verify returns null for garbage token', () => {
    assert.equal(verifyToken('aaabbbccc'), null);
    assert.equal(verifyToken(''), null);
    assert.equal(verifyToken('0'.repeat(64)), null);
  });
});
