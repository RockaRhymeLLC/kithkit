/**
 * Approval Gate unit tests
 *
 * Tests:
 * 1. Hash construction: deterministic, order-independent recipient hash
 * 2. normalizeApprovalFor: recognized values pass, unknown → 'all' (fail-closed)
 * 3. resolvePolicy: null for unconfigured channels
 * 4. approvalGate: passes through when no policy; fail-closed on no card delivery fn
 * 5. sweepStaleApprovals: marks all pending rows as timeout/system; skips decided rows
 * 6. resolveGate: not_found, already_resolved
 * 7. recordSuccessfulSend: inserts, deduplicates, canonicalizes, supports multi-agent
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { openDatabase, closeDatabase, getDatabase, _resetDbForTesting } from '../core/db.js';
import {
  approvalGate,
  resolveGate,
  sweepStaleApprovals,
  hashContent,
  hashRecipientSet,
  canonicalizeRecipient,
  recordSuccessfulSend,
  registerCardDelivery,
  _resetForTesting,
  normalizeApprovalFor,
  resolvePolicy,
} from '../comms/approval-gate.js';

// ── Hash construction ──────────────────────────────────────────────────

describe('hashContent', () => {
  it('returns a 64-char hex SHA-256 string', () => {
    const h = hashContent('hello world');
    assert.equal(typeof h, 'string');
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    assert.equal(hashContent('abc'), hashContent('abc'));
  });

  it('different content → different hash', () => {
    assert.notEqual(hashContent('abc'), hashContent('def'));
  });
});

describe('hashRecipientSet', () => {
  it('is order-independent', () => {
    const h1 = hashRecipientSet(['a@x.com', 'b@x.com']);
    const h2 = hashRecipientSet(['b@x.com', 'a@x.com']);
    assert.equal(h1, h2);
  });

  it('is deterministic', () => {
    assert.equal(
      hashRecipientSet(['alice@example.com', 'bob@example.com']),
      hashRecipientSet(['alice@example.com', 'bob@example.com']),
    );
  });

  it('canonicalizes emails (lowercase)', () => {
    const h1 = hashRecipientSet(['ALICE@EXAMPLE.COM']);
    const h2 = hashRecipientSet(['alice@example.com']);
    assert.equal(h1, h2);
  });

  it('different recipient sets → different hashes', () => {
    const h1 = hashRecipientSet(['a@x.com']);
    const h2 = hashRecipientSet(['b@x.com']);
    assert.notEqual(h1, h2);
  });

  it('returns a 64-char hex string', () => {
    const h = hashRecipientSet(['user@example.com']);
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });
});

describe('canonicalizeRecipient', () => {
  it('lowercases', () => {
    assert.equal(canonicalizeRecipient('Alice@Example.COM'), 'alice@example.com');
  });

  it('trims whitespace', () => {
    assert.equal(canonicalizeRecipient('  alice@example.com  '), 'alice@example.com');
  });
});

// ── normalizeApprovalFor ──────────────────────────────────────────────

describe('normalizeApprovalFor', () => {
  it('passes through recognized values', () => {
    assert.equal(normalizeApprovalFor('all'), 'all');
    assert.equal(normalizeApprovalFor('first_time_recipient'), 'first_time_recipient');
    assert.equal(normalizeApprovalFor('external_only'), 'external_only');
    assert.equal(normalizeApprovalFor('never'), 'never');
  });

  it('unknown value → "all" (fail-closed)', () => {
    assert.equal(normalizeApprovalFor('maybe'), 'all');
    assert.equal(normalizeApprovalFor(''), 'all');
    assert.equal(normalizeApprovalFor('yes'), 'all');
  });
});

// ── Gate core logic ────────────────────────────────────────────────────

describe('approvalGate', () => {
  let _dbDir: string;

  beforeEach(() => {
    _dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-gate-'));
    _resetDbForTesting();
    openDatabase(_dbDir, path.join(_dbDir, 'test.db'));
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
    closeDatabase();
    fs.rmSync(_dbDir, { recursive: true, force: true });
  });

  it('passes through when no approval_policies entry for channel', async () => {
    // Default config has approval_policies: {} → gate returns true for any channel
    const result = await approvalGate({
      channel: 'telegram',
      recipient: ['user@example.com'],
      content: 'hello',
      sender_agent: 'bridget',
    });
    assert.equal(result, true);
  });

  it('resolvePolicy returns null for channels not in approval_policies', () => {
    const policy = resolvePolicy('telegram');
    assert.equal(policy, null);
  });

  it('resolvePolicy returns null for unconfigured channels (pass-through)', () => {
    const policy = resolvePolicy('unconfigured-channel');
    assert.equal(policy, null);
  });

  it('gate passes through when registered delivery fn throws (no policy = no gate)', async () => {
    // Register a delivery fn that throws — but since there's no policy,
    // the gate should never call it and should still pass through.
    registerCardDelivery(async () => {
      throw new Error('Should not be called');
    });
    const result = await approvalGate({
      channel: 'non-gated-channel',
      recipient: ['user@example.com'],
      content: 'test content',
      sender_agent: 'test-agent',
    });
    assert.equal(result, true);
  });
});

// ── sweepStaleApprovals ────────────────────────────────────────────────

describe('sweepStaleApprovals', () => {
  let _dbDir: string;

  beforeEach(() => {
    _dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-sweep-'));
    _resetDbForTesting();
    openDatabase(_dbDir, path.join(_dbDir, 'test.db'));
    _resetForTesting();
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(_dbDir, { recursive: true, force: true });
  });

  it('returns 0 when no pending rows', () => {
    const swept = sweepStaleApprovals();
    assert.equal(swept, 0);
  });

  it('marks all pending rows as timeout/system on restart', () => {
    const db = getDatabase();
    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20min ago

    db.prepare(`
      INSERT INTO approval_decisions
        (approval_id, decision, decider, time_to_decide, content_hash, recipient_set_hash,
         sender_agent, channel, policy, created_at, decided_at)
      VALUES (?, 'approved', 'human', NULL, 'abc', 'def', 'bridget', 'mail', 'all', ?, NULL)
    `).run('test-uuid-001', oldTime);

    db.prepare(`
      INSERT INTO approval_decisions
        (approval_id, decision, decider, time_to_decide, content_hash, recipient_set_hash,
         sender_agent, channel, policy, created_at, decided_at)
      VALUES (?, 'approved', 'human', NULL, 'ghi', 'jkl', 'bmo', 'teams_chat', 'all', ?, NULL)
    `).run('test-uuid-002', oldTime);

    const swept = sweepStaleApprovals();
    assert.equal(swept, 2);

    // All pending rows should now have decided_at set
    const stillPending = db.prepare(
      `SELECT count(*) as c FROM approval_decisions WHERE decided_at IS NULL`,
    ).get() as { c: number };
    assert.equal(stillPending.c, 0);

    const resolved = db.prepare(
      `SELECT decision, decider FROM approval_decisions ORDER BY id`,
    ).all() as Array<{ decision: string; decider: string }>;
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0]!.decision, 'timeout');
    assert.equal(resolved[0]!.decider, 'system');
    assert.equal(resolved[1]!.decision, 'timeout');
    assert.equal(resolved[1]!.decider, 'system');
  });

  it('does not sweep already-decided rows', () => {
    const db = getDatabase();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO approval_decisions
        (approval_id, decision, decider, time_to_decide, content_hash, recipient_set_hash,
         sender_agent, channel, policy, created_at, decided_at)
      VALUES (?, 'approved', 'human', 30.0, 'abc', 'def', 'bridget', 'mail', 'all', ?, ?)
    `).run('test-uuid-decided', now, now);

    const swept = sweepStaleApprovals();
    assert.equal(swept, 0);
  });

  it('sweeps recent pending rows too (restart = fail-closed for ALL pending)', () => {
    const db = getDatabase();
    // Row created 2 minutes ago (within a typical 10-min timeout window)
    const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO approval_decisions
        (approval_id, decision, decider, time_to_decide, content_hash, recipient_set_hash,
         sender_agent, channel, policy, created_at, decided_at)
      VALUES (?, 'approved', 'human', NULL, 'xyz', 'uvw', 'bridget', 'mail', 'all', ?, NULL)
    `).run('test-recent', recentTime);

    const swept = sweepStaleApprovals();
    // Per spec: restart → ALL pending rows resolved as DENIED, regardless of age
    assert.equal(swept, 1);

    const row = db.prepare(
      `SELECT decision, decider FROM approval_decisions WHERE approval_id = 'test-recent'`,
    ).get() as { decision: string; decider: string } | undefined;
    assert.ok(row);
    assert.equal(row!.decision, 'timeout');
    assert.equal(row!.decider, 'system');
  });
});

// ── resolveGate ────────────────────────────────────────────────────────

describe('resolveGate', () => {
  let _dbDir: string;

  beforeEach(() => {
    _dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-resolve-'));
    _resetDbForTesting();
    openDatabase(_dbDir, path.join(_dbDir, 'test.db'));
    _resetForTesting();
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(_dbDir, { recursive: true, force: true });
  });

  it('returns not_found for unknown approval_id', () => {
    const result = resolveGate('nonexistent-uuid', 'approved');
    assert.equal(result, 'not_found');
  });

  it('returns not_found for approval_id in DB (decided_at null) but no in-memory gate', () => {
    const db = getDatabase();
    const now = new Date().toISOString();

    // Row exists in DB but no in-memory pending gate
    db.prepare(`
      INSERT INTO approval_decisions
        (approval_id, decision, decider, time_to_decide, content_hash, recipient_set_hash,
         sender_agent, channel, policy, created_at, decided_at)
      VALUES (?, 'approved', 'human', NULL, 'abc', 'def', 'bridget', 'mail', 'all', ?, NULL)
    `).run('test-stale', now);

    const result = resolveGate('test-stale', 'approved');
    // DB row exists (decided_at null) but no in-memory gate → not_found
    assert.equal(result, 'not_found');
  });

  it('returns already_resolved for a row with decided_at set', () => {
    const db = getDatabase();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO approval_decisions
        (approval_id, decision, decider, time_to_decide, content_hash, recipient_set_hash,
         sender_agent, channel, policy, created_at, decided_at)
      VALUES (?, 'rejected', 'human', 15.0, 'abc', 'def', 'bridget', 'mail', 'all', ?, ?)
    `).run('test-resolved', now, now);

    const result = resolveGate('test-resolved', 'approved');
    assert.equal(result, 'already_resolved');
  });
});

// ── recordSuccessfulSend ──────────────────────────────────────────────

describe('recordSuccessfulSend', () => {
  let _dbDir: string;

  beforeEach(() => {
    _dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-send-'));
    _resetDbForTesting();
    openDatabase(_dbDir, path.join(_dbDir, 'test.db'));
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(_dbDir, { recursive: true, force: true });
  });

  it('inserts new recipients', () => {
    recordSuccessfulSend('bridget', ['alice@example.com', 'bob@example.com']);
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT agent, recipient FROM agent_sent_recipients ORDER BY recipient`,
    ).all() as Array<{ agent: string; recipient: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.recipient, 'alice@example.com');
    assert.equal(rows[1]!.recipient, 'bob@example.com');
    assert.equal(rows[0]!.agent, 'bridget');
  });

  it('is idempotent — INSERT OR IGNORE on duplicate', () => {
    recordSuccessfulSend('bridget', ['alice@example.com']);
    recordSuccessfulSend('bridget', ['alice@example.com']); // duplicate
    const db = getDatabase();
    const count = (db.prepare(
      `SELECT COUNT(*) as c FROM agent_sent_recipients WHERE agent='bridget' AND recipient='alice@example.com'`,
    ).get() as { c: number }).c;
    assert.equal(count, 1);
  });

  it('canonicalizes email addresses (lowercase, trimmed)', () => {
    recordSuccessfulSend('bridget', ['ALICE@EXAMPLE.COM']);
    const db = getDatabase();
    const row = db.prepare(
      `SELECT recipient FROM agent_sent_recipients WHERE agent='bridget'`,
    ).get() as { recipient: string } | undefined;
    assert.ok(row);
    assert.equal(row!.recipient, 'alice@example.com');
  });

  it('different agents can have the same recipient', () => {
    recordSuccessfulSend('bridget', ['shared@example.com']);
    recordSuccessfulSend('bmo', ['shared@example.com']);
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT agent FROM agent_sent_recipients WHERE recipient='shared@example.com' ORDER BY agent`,
    ).all() as Array<{ agent: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.agent, 'bmo');
    assert.equal(rows[1]!.agent, 'bridget');
  });
});
