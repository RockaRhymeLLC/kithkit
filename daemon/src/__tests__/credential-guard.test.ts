/**
 * Write-path credential guard tests.
 *
 * All "live token" fixtures below are generated in-test via issueToken()
 * against an isolated temp DB (see setupDb) — never a real production token
 * or a file read from disk. Shape-pattern fixtures use obviously-synthetic
 * placeholder segments; they are not real credentials for any service.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, insert, get, getDatabase } from '../core/db.js';
import { issueToken } from '../auth/agent-tokens.js';
import {
  checkForCredentialLeak,
  assertFieldSafe,
  assertRecordSafe,
  guardOrPlaceholder,
  sanitizeRecordOrPlaceholder,
  invalidateCredentialGuardCache,
  CredentialLeakError,
} from '../security/credential-guard.js';

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-credguard-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  invalidateCredentialGuardCache();
}

function teardownDb(): void {
  invalidateCredentialGuardCache();
  _resetDbForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Layer 1: oracle (exact match against issued tokens) ─────────

describe('credential-guard: oracle — live issued token', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('blocks a value containing a live active token', () => {
    const token = issueToken('worker', { jobId: 'job-test-1' });
    const result = checkForCredentialLeak(`I ran the command and got: ${token}`);
    assert.equal(result.blocked, true);
    assert.equal(result.matchType, 'oracle');
  });

  it('assertFieldSafe throws CredentialLeakError for a live token', () => {
    const token = issueToken('comms');
    assert.throws(
      () => assertFieldSafe('worker_jobs', 'result', `output was ${token}`),
      CredentialLeakError,
    );
  });

  it('does not block a token-shaped string that was never issued', () => {
    // Same length/charset class as a real token but never inserted via issueToken.
    const neverIssued = 'z'.repeat(64);
    const result = checkForCredentialLeak(`some value ${neverIssued}`);
    assert.equal(result.blocked, false);
  });

  it('does not block after the matching token is revoked past the grace window', () => {
    const token = issueToken('worker', { jobId: 'job-test-2' });
    // Simulate a revocation older than the 24h grace window by writing
    // revoked_at directly in the past (test-only DB manipulation).
    const db = getDatabase();
    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE token = ?').run(oldTs, token);
    invalidateCredentialGuardCache();

    const result = checkForCredentialLeak(`output was ${token}`);
    assert.equal(result.blocked, false);
  });

  it('still blocks a token revoked within the 24h grace window (rotation race)', () => {
    const token = issueToken('worker', { jobId: 'job-test-3' });
    const db = getDatabase();
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // revoked 5 min ago
    db.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE token = ?').run(recentTs, token);
    invalidateCredentialGuardCache();

    const result = checkForCredentialLeak(`output was ${token}`);
    assert.equal(result.blocked, true, 'a token revoked moments ago should still be caught by the grace window');
  });
});

// ── Layer 1 negative control: ordinary prose about tokens ───────

describe('credential-guard: prose-negative control', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('does not block prose that discusses tokens/fingerprints without the literal value', () => {
    // A live token exists in the oracle set, but this sentence never includes it —
    // it only names the mechanism, matching the real incident pattern this guard
    // must NOT misfire on (discussing auth, not leaking a secret).
    issueToken('comms');
    const prose =
      'I verified the comms token via X-Agent-Token and fingerprint 4aa9c619. ' +
      'Bearer auth on /api/send returned 200. The agent role header and service ' +
      'name were both present in the request.';
    const result = checkForCredentialLeak(prose);
    assert.equal(result.blocked, false);
  });

  it('does not block a fingerprint-only reference (short hex, not a full token)', () => {
    issueToken('worker', { jobId: 'job-test-4' });
    const result = checkForCredentialLeak('token fingerprint: 4aa9c619 (first 8 chars)');
    assert.equal(result.blocked, false);
  });
});

// ── Layer 2: shape patterns ───────────────────────────────────

describe('credential-guard: shape patterns', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('fires on a JWT-shaped value', () => {
    const bait =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJTWU5USEVUSUMtVEVTVC1TVUJKRUNUIn0.' +
      'SYNTHETIC_TEST_SIGNATURE_ABCDEF0123456789';
    const result = checkForCredentialLeak(`auth header was: ${bait}`);
    assert.equal(result.blocked, true);
    assert.equal(result.matchType, 'shape');
    assert.equal(result.shapeKind, 'JWT');
  });

  it('fires on a GitHub-token-shaped value', () => {
    const bait = 'ghp_' + 'SYNTHETICTESTVALUE0123456789ABCDEFGHIJK';
    const result = checkForCredentialLeak(`pushed with ${bait}`);
    assert.equal(result.blocked, true);
    assert.equal(result.matchType, 'shape');
    assert.equal(result.shapeKind, 'GitHub token');
  });

  it('fires on an Anthropic-API-key-shaped value', () => {
    const bait = 'sk-ant-' + 'SYNTHETIC0123456789TESTVALUEABCDEF';
    const result = checkForCredentialLeak(`the key was ${bait}`);
    assert.equal(result.blocked, true);
    assert.equal(result.matchType, 'shape');
    assert.equal(result.shapeKind, 'Anthropic API key');
  });

  it('does not fire on benign header/service names (anti-pattern check)', () => {
    // The prior classifier this guard replaces misfired by keying off words like
    // "token"/"Bearer"/"X-Agent-Token" — this asserts we do NOT do that.
    const prose = 'Bearer token support was added to the X-Agent-Token header for the github-sync service.';
    const result = checkForCredentialLeak(prose);
    assert.equal(result.blocked, false);
  });
});

// ── Caching: no per-call DB re-query ─────────────────────────────

describe('credential-guard: oracle cache', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('does not re-query the DB on every check within the TTL window', () => {
    const token = issueToken('worker', { jobId: 'job-cache-1' });
    const db = getDatabase();

    // Prime the cache with one check.
    checkForCredentialLeak(`warm ${token}`);

    let prepareCalls = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes('agent_tokens')) prepareCalls++;
      return originalPrepare(sql);
    }) as typeof db.prepare;

    for (let i = 0; i < 25; i++) {
      checkForCredentialLeak(`value #${i}: ${token}`);
    }

    db.prepare = originalPrepare;
    assert.equal(prepareCalls, 0, 'expected zero agent_tokens queries for 25 checks within the cache TTL');
  });

  it('reloads after invalidateCredentialGuardCache() is called', () => {
    const db = getDatabase();

    checkForCredentialLeak('warm the cache with no tokens issued yet');

    const token = issueToken('worker', { jobId: 'job-cache-2' });
    // Without invalidation, the just-issued token would not yet be visible
    // (still within the 10s TTL window) — invalidate to force a reload.
    invalidateCredentialGuardCache();

    let sawQuery = false;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes('agent_tokens')) sawQuery = true;
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const result = checkForCredentialLeak(`fresh check ${token}`);

    db.prepare = originalPrepare;
    assert.equal(sawQuery, true, 'expected a reload after explicit invalidation');
    assert.equal(result.blocked, true);
  });
});

// ── Reject vs placeholder behavior ───────────────────────────────

describe('credential-guard: reject (assertFieldSafe / assertRecordSafe)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('assertRecordSafe throws and the caller can inspect table/field/matchType', () => {
    const token = issueToken('orchestrator');
    try {
      assertRecordSafe('tasks', { work_notes: `progress notes: ${token}`, title: 'ok' });
      assert.fail('expected CredentialLeakError to be thrown');
    } catch (err) {
      assert.ok(err instanceof CredentialLeakError);
      assert.equal(err.table, 'tasks');
      assert.equal(err.field, 'work_notes');
      assert.equal(err.matchType, 'oracle');
    }
  });

  it('assertRecordSafe is a no-op for clean data', () => {
    assert.doesNotThrow(() =>
      assertRecordSafe('tasks', { work_notes: 'clean progress notes, no secrets here', title: 'ok' }),
    );
  });

  it('assertRecordSafe skips tables with no watched fields', () => {
    assert.doesNotThrow(() => assertRecordSafe('agents', { name: 'whatever' }));
  });

  it('nothing is persisted when assertRecordSafe rejects (caller controls the INSERT)', () => {
    const token = issueToken('worker', { jobId: 'job-reject-1' });
    const taskId = 'task-reject-test-1';
    assert.throws(() => {
      assertRecordSafe('tasks', { work_notes: `notes with ${token}` });
      // A real call site would only reach this INSERT if assertRecordSafe did
      // not throw — asserting the throw happens *before* any write proves the
      // guard blocks the write rather than merely logging around it.
      insert('tasks', { id: taskId, kind: 'todo', title: 'unreachable', work_notes: `notes with ${token}` });
    }, CredentialLeakError);
    assert.equal(get('tasks', taskId), undefined);
  });
});

describe('credential-guard: placeholder (guardOrPlaceholder / sanitizeRecordOrPlaceholder)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('guardOrPlaceholder returns the value unchanged when clean', () => {
    const out = guardOrPlaceholder('worker_jobs', 'result', 'all good, no secrets');
    assert.equal(out, 'all good, no secrets');
  });

  it('guardOrPlaceholder replaces a blocked value with a labelled placeholder, not the raw error', () => {
    const token = issueToken('worker', { jobId: 'job-ph-1' });
    const out = guardOrPlaceholder('worker_jobs', 'result', `final output: ${token}`);
    assert.match(out, /^\[CREDENTIAL-GUARD-BLOCKED\]/);
    assert.equal(out.includes(token), false, 'placeholder must not contain the original secret');
  });

  it('sanitizeRecordOrPlaceholder preserves clean sibling fields and only replaces the leaking one', () => {
    const token = issueToken('worker', { jobId: 'job-ph-2' });
    const record = {
      status: 'completed',
      result: `done: ${token}`,
      error: null as string | null,
      tokens_in: 100,
    };
    const out = sanitizeRecordOrPlaceholder('worker_jobs', record);
    assert.equal(out.status, 'completed');
    assert.equal(out.tokens_in, 100);
    assert.match(out.result as string, /^\[CREDENTIAL-GUARD-BLOCKED\]/);
    assert.equal(out.error, null);
  });

  it('sanitizeRecordOrPlaceholder never throws — always returns a full record', () => {
    const token = issueToken('worker', { jobId: 'job-ph-3' });
    assert.doesNotThrow(() => sanitizeRecordOrPlaceholder('worker_jobs', { result: token, error: null }));
  });
});

// ── New write-path chokepoints ───────────────────────────────────
//
// WATCHED_FIELDS.tasks was expanded to cover description, plan,
// plan_rejected_reason, outcome_reason, and comms_corrections (in addition
// to the pre-existing work_notes/result/error), and WATCHED_FIELDS.task_activity
// now covers message. Each field below gets a positive control (a live
// issued token must be rejected) and a prose-negative control (ordinary
// text that names auth mechanisms/fingerprints/hex-looking IDs must NOT
// fire) — the same false-positive class the top-of-file prose-negative
// suite guards against, applied to each new field individually.

describe('credential-guard: new tasks fields (description, plan, plan_rejected_reason, outcome_reason, comms_corrections)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  const newTasksFields = ['description', 'plan', 'plan_rejected_reason', 'outcome_reason', 'comms_corrections'] as const;

  for (const field of newTasksFields) {
    it(`assertRecordSafe rejects a live token in tasks.${field}`, () => {
      const token = issueToken('orchestrator');
      try {
        assertRecordSafe('tasks', { [field]: `see: ${token}`, title: 'ok' });
        assert.fail(`expected CredentialLeakError to be thrown for ${field}`);
      } catch (err) {
        assert.ok(err instanceof CredentialLeakError);
        assert.equal(err.table, 'tasks');
        assert.equal(err.field, field);
        assert.equal(err.matchType, 'oracle');
      }
    });

    it(`does not fire on ordinary prose in tasks.${field} (prose negative control)`, () => {
      issueToken('comms');
      const prose =
        'Reviewed the change: auth now checks the X-Agent-Token header and validated the request ' +
        'fingerprint 4aa9c619 against the record with sys_id 7c3e1a90b2f4471aa9c6198bd2e4f011. ' +
        'No further action needed.';
      assert.doesNotThrow(() => assertRecordSafe('tasks', { [field]: prose, title: 'ok' }));
    });
  }

  it('assertRecordSafe rejects a GitHub-token-shaped value in tasks.plan', () => {
    const bait = 'ghp_' + 'SYNTHETICTESTVALUE0123456789ABCDEFGHIJK';
    try {
      assertRecordSafe('tasks', { plan: `step 1: authenticate with ${bait}` });
      assert.fail('expected CredentialLeakError to be thrown');
    } catch (err) {
      assert.ok(err instanceof CredentialLeakError);
      assert.equal(err.field, 'plan');
      assert.equal(err.matchType, 'shape');
    }
  });

  it('nothing is persisted when a plan-submit-shaped write is rejected', () => {
    const token = issueToken('worker', { jobId: 'job-plan-reject-1' });
    const taskId = 'task-plan-reject-test-1';
    assert.throws(() => {
      assertRecordSafe('tasks', { plan: `plan step: run with ${token}` });
      insert('tasks', { id: taskId, kind: 'todo', title: 'unreachable', plan: `plan step: run with ${token}` });
    }, CredentialLeakError);
    assert.equal(get('tasks', taskId), undefined);
  });
});

describe('credential-guard: new task_activity.message field', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('assertRecordSafe rejects a live token in task_activity.message', () => {
    const token = issueToken('worker', { jobId: 'job-activity-1' });
    try {
      assertRecordSafe('task_activity', { message: `activity note: ${token}` });
      assert.fail('expected CredentialLeakError to be thrown');
    } catch (err) {
      assert.ok(err instanceof CredentialLeakError);
      assert.equal(err.table, 'task_activity');
      assert.equal(err.field, 'message');
      assert.equal(err.matchType, 'oracle');
    }
  });

  it('does not fire on ordinary activity prose (prose negative control)', () => {
    issueToken('orchestrator');
    const prose =
      'Worker completed. Verified the response carried a valid Bearer token via X-Agent-Token ' +
      'and the agent fingerprint a1b2c3d4 matched the expected sys_id e4f5a6b7c8d940102030405060708090.';
    assert.doesNotThrow(() => assertRecordSafe('task_activity', { message: prose }));
  });

  it('assertRecordSafe is a no-op for task_activity fields other than message', () => {
    assert.doesNotThrow(() => assertRecordSafe('task_activity', { stage: 'cleanup', type: 'note', agent: 'daemon' }));
  });
});

describe('credential-guard: worker_jobs.verification_report (placeholder path)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('sanitizeRecordOrPlaceholder replaces a leaking verification_report with a labelled placeholder', () => {
    const token = issueToken('worker', { jobId: 'job-verify-1' });
    const record = {
      status: 'completed',
      verification_report: JSON.stringify({ notes: `checked with ${token}` }),
    };
    const out = sanitizeRecordOrPlaceholder('worker_jobs', record);
    assert.match(out.verification_report as string, /^\[CREDENTIAL-GUARD-BLOCKED\]/);
    assert.equal((out.verification_report as string).includes(token), false);
    assert.equal(out.status, 'completed');
  });

  it('sanitizeRecordOrPlaceholder leaves a clean verification_report untouched', () => {
    const record = { verification_report: JSON.stringify({ notes: 'all claims verified against source' }) };
    const out = sanitizeRecordOrPlaceholder('worker_jobs', record);
    assert.equal(out.verification_report, record.verification_report);
  });

  it('does not fire on ordinary prose in verification_report (prose negative control)', () => {
    issueToken('comms');
    const report = JSON.stringify({
      notes: 'Confirmed the handler checks X-Agent-Token and rejected a request with fingerprint 4aa9c619.',
    });
    const out = sanitizeRecordOrPlaceholder('worker_jobs', { verification_report: report });
    assert.equal(out.verification_report, report);
  });
});
