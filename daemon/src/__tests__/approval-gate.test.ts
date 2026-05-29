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
import http from 'node:http';
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
  getPendingGates,
  _resetForTesting,
  normalizeApprovalFor,
  resolvePolicy,
} from '../comms/approval-gate.js';
import { loadConfig, _resetConfigForTesting } from '../core/config.js';
import { handleApprovalRoute } from '../api/approval.js';
import { issueToken } from '../auth/agent-tokens.js';

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
      rawContent: 'hello',
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
      rawContent: 'test content',
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

// ── FIX #1: pending placeholder ──────────────────────────────────────

describe('approvalGate: pending row placeholder', () => {
  let _dbDir: string;

  beforeEach(() => {
    _dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-placeholder-'));
    _resetDbForTesting();
    openDatabase(_dbDir, path.join(_dbDir, 'test.db'));
    _resetForTesting();
    // Inject a policy for 'mail' so the gate actually fires
    fs.writeFileSync(path.join(_dbDir, 'kithkit.config.yaml'), [
      'approval_policies:',
      '  mail:',
      '    require_approval_for: all',
      '    timeout_minutes: 1',
    ].join('\n'));
    _resetConfigForTesting();
    loadConfig(_dbDir);
  });

  afterEach(() => {
    _resetForTesting();
    _resetConfigForTesting();
    closeDatabase();
    fs.rmSync(_dbDir, { recursive: true, force: true });
  });

  it('inserts pending row with decision="pending" (not "approved")', async () => {
    const db = getDatabase();

    // Delivery fn that stalls until we release it
    let deliverResolve!: () => void;
    registerCardDelivery(() => new Promise<void>((res) => { deliverResolve = res; }));

    // writeDecisionRow is called synchronously before approvalGate returns its Promise,
    // so the row is already in DB by the time we reach the next line.
    const gatePromise = approvalGate({
      channel: 'mail',
      recipient: ['test@example.com'],
      content: '[FORMATTED] hello world',
      rawContent: 'hello world',
      sender_agent: 'bridget',
    });

    // Inspect the DB row — written synchronously, no need for setImmediate
    const row = db.prepare(
      `SELECT decision, decided_at FROM approval_decisions WHERE decided_at IS NULL LIMIT 1`,
    ).get() as { decision: string; decided_at: string | null } | undefined;

    assert.ok(row, 'Expected a pending row in approval_decisions');
    assert.equal(row!.decision, 'pending', 'Placeholder decision must be "pending", not "approved"');
    assert.equal(row!.decided_at, null);

    // Clean up: resolve the in-memory gate so gatePromise settles
    for (const g of getPendingGates().values()) {
      resolveGate(g.card.approval_id, 'rejected');
    }
    deliverResolve();
    await gatePromise;
  });
});

// ── FIX #2: content_hash uses raw content ────────────────────────────

describe('approvalGate: content_hash uses rawContent', () => {
  let _dbDir: string;

  beforeEach(() => {
    _dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-hash-'));
    _resetDbForTesting();
    openDatabase(_dbDir, path.join(_dbDir, 'test.db'));
    _resetForTesting();
    // Inject a policy for 'mail'
    fs.writeFileSync(path.join(_dbDir, 'kithkit.config.yaml'), [
      'approval_policies:',
      '  mail:',
      '    require_approval_for: all',
      '    timeout_minutes: 1',
    ].join('\n'));
    _resetConfigForTesting();
    loadConfig(_dbDir);
  });

  afterEach(() => {
    _resetForTesting();
    _resetConfigForTesting();
    closeDatabase();
    fs.rmSync(_dbDir, { recursive: true, force: true });
  });

  it('content_hash in DB matches SHA-256 of rawContent, not formatted content', async () => {
    const db = getDatabase();
    const rawText = 'hello world';
    const formattedText = '[FORMATTED] hello world';

    let deliverResolve!: () => void;
    registerCardDelivery(() => new Promise<void>((res) => { deliverResolve = res; }));

    const gatePromise = approvalGate({
      channel: 'mail',
      recipient: ['test@example.com'],
      content: formattedText,
      rawContent: rawText,
      sender_agent: 'bridget',
    });

    // Row written synchronously
    const row = db.prepare(
      `SELECT content_hash FROM approval_decisions WHERE decided_at IS NULL LIMIT 1`,
    ).get() as { content_hash: string } | undefined;

    assert.ok(row, 'Expected a pending row in approval_decisions');
    const expectedHash = hashContent(rawText);
    const wrongHash = hashContent(formattedText);
    assert.equal(row!.content_hash, expectedHash, 'content_hash must match SHA-256 of rawContent');
    assert.notEqual(row!.content_hash, wrongHash, 'content_hash must NOT match formatted content');

    // Clean up
    for (const g of getPendingGates().values()) {
      resolveGate(g.card.approval_id, 'rejected');
    }
    deliverResolve();
    await gatePromise;
  });
});

// ── FIX #3: decision endpoint auth ───────────────────────────────────

const APPROVAL_TEST_PORT = 19895;

function approvalRequest(
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: APPROVAL_TEST_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
        ...extraHeaders,
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

describe('POST /api/approval/decision auth', () => {
  let _dbDir: string;
  let _server: http.Server;
  let commsToken: string;
  let workerToken: string;

  beforeEach(async () => {
    _dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-api-'));
    _resetDbForTesting();
    openDatabase(_dbDir, path.join(_dbDir, 'test.db'));
    _resetForTesting();
    commsToken = issueToken('comms');
    workerToken = issueToken('worker');

    _server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${APPROVAL_TEST_PORT}`);
      handleApprovalRoute(req, res, url.pathname).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      }).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    await new Promise<void>((res) => _server.listen(APPROVAL_TEST_PORT, '127.0.0.1', res));
  });

  afterEach(async () => {
    _resetForTesting();
    closeDatabase();
    await new Promise<void>((res) => _server.close(() => {
      _resetDbForTesting();
      fs.rmSync(_dbDir, { recursive: true, force: true });
      res();
    }));
  });

  it('rejects with 401 when no X-Agent-Token header', async () => {
    const res = await approvalRequest('POST', '/api/approval/decision', {
      approval_id: 'some-id',
      decision: 'approved',
    });
    assert.equal(res.status, 401);
    const body = JSON.parse(res.body) as { error: string };
    assert.ok(body.error.includes('X-Agent-Token'), `Expected X-Agent-Token in error, got: ${body.error}`);
  });

  it('rejects with 401 when token is invalid', async () => {
    const res = await approvalRequest(
      'POST',
      '/api/approval/decision',
      { approval_id: 'some-id', decision: 'approved' },
      { 'X-Agent-Token': 'notarealtoken0000000000000000000000000000000000000000000' },
    );
    assert.equal(res.status, 401);
  });

  it('rejects with 403 when token is valid but not comms role', async () => {
    const res = await approvalRequest(
      'POST',
      '/api/approval/decision',
      { approval_id: 'some-id', decision: 'approved' },
      { 'X-Agent-Token': workerToken },
    );
    assert.equal(res.status, 403);
  });

  it('allows comms-role token through to business logic (404 means auth passed)', async () => {
    // A valid comms token should pass auth; the 'some-nonexistent-id' will return 404 from resolveGate
    const res = await approvalRequest(
      'POST',
      '/api/approval/decision',
      { approval_id: 'some-nonexistent-id', decision: 'approved' },
      { 'X-Agent-Token': commsToken },
    );
    // Auth passed → resolveGate returns 'not_found' → 404 (not 401/403)
    assert.equal(res.status, 404);
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
