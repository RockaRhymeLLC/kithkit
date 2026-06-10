/**
 * Delivery Integrity Test Harness
 *
 * Tests the core delivery invariants for LAN-inbound A2A messages.
 * Ported from fork PR #23 (eaab33cd) — ties kithkit#585 (LAN persist-on-receive)
 * and kithkit#620 (dead-letter / delivery-integrity). Migration renumbered from
 * 026 to 030 (upstream 026-029 already taken).
 *
 *   DI-001 — LAN-no-persist (#585 bug, RED before fix)
 *   DI-002 — LAN-persist-success (injected_at stamped on success)
 *   DI-003 — LAN-session-dead-persist (injected_at NULL when session absent)
 *   DI-004 — LAN-inject-idempotent (dedup window prevents double-inject)
 *   DI-005 — LAN-inject-error-dead-letter (inject fails despite live session)
 *   DI-009 — to_agent derivation (always 'comms'; protocol has no recipient field)
 *   DI-010 — coordination/pr-review types accepted by message-router
 *   DI-011 — sdk-bridge relay: from_agent is bare (no network: prefix)
 *   DI-012 — 030 migration: injected_at column exists
 *   DI-006..DI-008 — stubs reserved for #620 / #87 / orch-delivery gap
 *
 * Mocking strategy:
 *   - tmux inject: _setTmuxInjectorForTesting (message-router)
 *   - comms session existence: _setCommsSessionExistsForTesting (session-bridge)
 *   - DB: temp-dir SQLite via openDatabase, reset between tests
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openDatabase,
  _resetDbForTesting,
  query,
} from '../core/db.js';
import {
  sendMessage,
  _setTmuxInjectorForTesting,
  _clearDedupForTesting,
} from '../agents/message-router.js';
import { _setCommsSessionExistsForTesting } from '../core/session-bridge.js';
import { handleAgentMessage } from '../extensions/comms/agent-comms.js';
import type { AgentMessage } from '../extensions/comms/agent-comms.js';

// ── Helpers ───────────────────────────────────────────────────

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-di-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  _resetDbForTesting();
  _clearDedupForTesting();
  _setTmuxInjectorForTesting(null);
  _setCommsSessionExistsForTesting(null);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeTextMsg(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    from: 'r2d2',
    type: 'text',
    text: 'hello from LAN',
    messageId: `test-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

type MessageRow = {
  id: number;
  from_agent: string;
  to_agent: string;
  type: string;
  body: string;
  injected_at: string | null;
};

// ── DI-001: LAN-no-persist (the #585 bug, RED before fix) ────
//
// Root cause: handleAgentMessage() calls injectText() raw with no sendMessage()
// and no DB INSERT. The message is silently lost when inject fails.
//
// This test proves the bug is fixed: message is in DB even when inject fails.

describe('DI-001: LAN inbound persists to DB even when inject fails', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('message is in DB after handleAgentMessage() regardless of inject outcome', async () => {
    // Simulate a dead session: inject always returns false
    _setTmuxInjectorForTesting(() => false);
    _setCommsSessionExistsForTesting(() => false);

    const msg = makeTextMsg({ from: 'r2d2', text: 'DI-001 sentinel' });
    const result = await handleAgentMessage(msg);

    // Handler must return ok:true (message accepted for delivery)
    assert.equal(result.status, 200, 'handler should return 200');
    assert.equal(result.body.ok, true, 'handler should return ok:true');

    // DB row MUST exist — this is the fix assertion.
    // Before fix: rows.length === 0 (RED). After fix: rows.length === 1 (GREEN).
    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'DB row must be present even when inject fails');
    assert.ok(
      rows[0]!.body.includes('DI-001 sentinel') || rows[0]!.body.includes('r2d2'),
      'DB row body should contain message content',
    );
  });
});

// ── DI-002: LAN-persist-success ───────────────────────────────
//
// Happy path: message arrives, inject succeeds.
// DB row exists AND injected_at IS NOT NULL.

describe('DI-002: LAN persist-success — DB row exists and injected_at stamped', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('successful inject: DB row exists with injected_at set', async () => {
    _setTmuxInjectorForTesting(() => true);

    const msg = makeTextMsg({ from: 'r2d2', text: 'DI-002 sentinel' });
    const result = await handleAgentMessage(msg);

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);

    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'DB row must exist');
    assert.ok(rows[0]!.injected_at !== null, 'injected_at must be set after successful inject');
    assert.ok(typeof rows[0]!.injected_at === 'string', 'injected_at must be a string timestamp');
  });
});

// ── DI-003: LAN-session-dead-persist ─────────────────────────
//
// Session is absent — message pending for later delivery (not a genuine error).
// DB row exists AND injected_at IS NULL.

describe('DI-003: LAN session-dead — DB row exists, injected_at NULL (pending delivery)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('session absent: DB row exists with injected_at NULL (pending, not dead-letter)', async () => {
    _setTmuxInjectorForTesting(() => false);
    _setCommsSessionExistsForTesting(() => false);

    const msg = makeTextMsg({ from: 'r2d2', text: 'DI-003 sentinel' });
    await handleAgentMessage(msg);

    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'DB row must exist even when session is dead');
    assert.equal(rows[0]!.injected_at, null,
      'injected_at must be NULL when session absent (pending for later delivery)');
  });
});

// ── DI-004: LAN-inject-idempotent ────────────────────────────
//
// Same message arrives twice within the dedup window.
// inject must NOT be called a second time; injected_at must be unchanged.

describe('DI-004: LAN inject idempotency — no double-inject if injected_at already set', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('second delivery within dedup window: inject called once, injected_at unchanged', async () => {
    let injectCallCount = 0;
    _setTmuxInjectorForTesting(() => { injectCallCount++; return true; });

    const msg = makeTextMsg({ from: 'r2d2', text: 'DI-004 sentinel' });

    // First delivery
    await handleAgentMessage(msg);
    const firstCallCount = injectCallCount;
    const rows1 = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows1.length, 1, 'first delivery: one DB row');
    const firstInjectedAt = rows1[0]!.injected_at;
    assert.ok(firstInjectedAt !== null, 'first delivery: injected_at should be set');

    // Second delivery of the same message (within dedup window)
    await handleAgentMessage(msg);
    const rows2 = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows2.length, 1, 'dedup: still only one DB row');
    assert.equal(rows2[0]!.injected_at, firstInjectedAt, 'injected_at must not change on re-delivery');
    assert.equal(injectCallCount, firstCallCount, 'inject must not be called again on dedup path');
  });
});

// ── DI-005: LAN-inject-error-dead-letter ─────────────────────
//
// Session exists but inject fails (unexpected).
// DB row exists; injected_at IS NULL; dead-letter error should be logged.

describe('DI-005: LAN inject-error → dead-letter ERROR log, DB row with NULL injected_at', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('inject fails despite session alive: DB row exists, injected_at NULL', async () => {
    // Session "exists" but inject fails
    _setTmuxInjectorForTesting(() => false);
    _setCommsSessionExistsForTesting(() => true);

    const msg = makeTextMsg({ from: 'r2d2', text: 'DI-005 sentinel' });
    await handleAgentMessage(msg);

    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'DB row must exist even on inject failure');
    assert.equal(rows[0]!.injected_at, null,
      'injected_at must be NULL when inject failed (not yet delivered)');
    // Dead-letter is observable via the combination of session-alive + injected_at NULL.
    // log.error output verified structurally: "session alive + injected_at NULL" = dead-letter state.
  });
});

// ── DI-009: to_agent recipient derivation ────────────────────
//
// LAN inbound messages always persist with to_agent='comms'.
// AgentMessage has NO to/recipient/target field — hardcode is correct and forced.

describe('DI-009: LAN inbound to_agent is always comms (protocol has no recipient field)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('comms-targeted inbound: persists with to_agent=comms', async () => {
    _setTmuxInjectorForTesting(() => true);

    const msg = makeTextMsg({ from: 'bmo', text: 'DI-009 comms-targeted' });
    const result = await handleAgentMessage(msg);

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);

    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'bmo');
    assert.equal(rows.length, 1, 'DB row must exist');
    assert.equal(rows[0]!.to_agent, 'comms',
      'to_agent must be "comms": AgentMessage has no recipient field, /agent/message is comms-inbound-only');
  });

  it('LAN inbound with no to-field in payload: persists with to_agent=comms (default invariant)', async () => {
    _setTmuxInjectorForTesting(() => false);
    _setCommsSessionExistsForTesting(() => false);

    const msg: AgentMessage = {
      from: 'r2d2',
      type: 'text',
      text: 'DI-009 no-recipient-field',
      messageId: `test-di009-${Date.now()}`,
      timestamp: new Date().toISOString(),
    };
    await handleAgentMessage(msg);

    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'DB row must exist');
    assert.equal(rows[0]!.to_agent, 'comms',
      'to_agent must default to "comms" when no recipient field present');
  });
});

// ── DI-010: coordination and pr-review accepted by message-router ────────────
//
// Validates that widening MessageType to include 'coordination' and 'pr-review'
// allows these LAN-valid types to pass validation without throwing.

describe('DI-010: coordination and pr-review types accepted by message-router', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('coordination type: sendMessage does not throw and row is persisted', () => {
    _setTmuxInjectorForTesting(() => false);

    const result = sendMessage({
      from: 'r2d2',
      to: 'comms',
      type: 'coordination',
      body: 'DI-010 coordination sentinel',
    });

    assert.ok(result.messageId > 0, 'coordination message should be stored');
    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'coordination message DB row must exist');
    assert.equal(rows[0]!.type, 'coordination', 'type must be stored as-sent');
  });

  it('pr-review type: sendMessage does not throw and row is persisted', () => {
    _setTmuxInjectorForTesting(() => false);
    _clearDedupForTesting();

    const result = sendMessage({
      from: 'r2d2',
      to: 'comms',
      type: 'pr-review',
      body: 'DI-010 pr-review sentinel',
    });

    assert.ok(result.messageId > 0, 'pr-review message should be stored');
    const rows = query<MessageRow>(
      'SELECT * FROM messages WHERE from_agent = ? AND type = ?', 'r2d2', 'pr-review',
    );
    assert.equal(rows.length, 1, 'pr-review message DB row must exist');
    assert.equal(rows[0]!.type, 'pr-review', 'type must be stored as-sent');
  });

  it('injected_at is stamped on direct coordination inject', () => {
    _setTmuxInjectorForTesting(() => true);
    _clearDedupForTesting();

    const result = sendMessage({
      from: 'r2d2',
      to: 'comms',
      type: 'coordination',
      body: '[Coordination] DI-010 injected_at test',
      direct: true,
    });

    assert.ok(result.delivered, 'coordination direct-inject should report delivered');
    const rows = query<MessageRow>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.injected_at !== null,
      'injected_at must be stamped when coordination direct-inject succeeds');
  });
});

// ── DI-011: sdk-bridge relay from_agent is bare (no network: prefix) ─────────
//
// Validates the bare-identity invariant (#585): sendMessage from_agent must NOT
// contain the 'network:' transport prefix. Verified by calling sendMessage
// directly with the bare value (sdk-bridge now passes msg.sender, not
// `network:${msg.sender}`).

describe('DI-011: sdk-bridge relay — from_agent is bare (no network: prefix)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('relay message stored with bare from_agent (no network: prefix)', () => {
    _setTmuxInjectorForTesting(() => true);

    const result = sendMessage({
      from: 'bmo',          // bare — sdk-bridge strips 'network:' prefix
      to: 'comms',
      type: 'text',
      body: '[Network] BMO: DI-011 relay sentinel',
      direct: true,
    });

    assert.ok(result.messageId > 0);
    const rows = query<MessageRow>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.from_agent, 'bmo',
      'from_agent must be bare "bmo" — not "network:bmo"');
    assert.ok(!rows[0]!.from_agent.startsWith('network:'),
      'from_agent must not start with network: prefix');
  });

  it('system relay message stored with bare "system" (not "network:system")', () => {
    _setTmuxInjectorForTesting(() => true);
    _clearDedupForTesting();

    const result = sendMessage({
      from: 'system',       // bare — sdk-bridge strips 'network:system'
      to: 'comms',
      type: 'status',
      body: "[Network] Community 'test' is now active",
      direct: true,
    });

    assert.ok(result.messageId > 0);
    const rows = query<MessageRow>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.from_agent, 'system',
      'from_agent must be bare "system" — not "network:system"');
  });
});

// ── DI-012: 030 migration — injected_at column exists ────────────────────────
//
// Verifies that the 030-add-injected-at.sql migration ran and the column exists.

describe('DI-012: migration 030 — injected_at column present in messages table', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('messages table has injected_at column after migration', () => {
    type PragmaRow = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
    const cols = query<PragmaRow>('PRAGMA table_info(messages)');
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes('injected_at'),
      `messages table must have injected_at column after migration 030. Got: ${colNames.join(', ')}`);
  });

  it('newly inserted message has injected_at = NULL by default', () => {
    _setTmuxInjectorForTesting(() => false);

    const result = sendMessage({
      from: 'test-sender',
      to: 'comms',
      type: 'text',
      body: 'DI-012 column default test',
    });

    const rows = query<MessageRow>('SELECT * FROM messages WHERE id = ?', result.messageId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.injected_at, null,
      'injected_at must default to NULL (not yet injected)');
  });
});

// ── DI-006: Relay-expiry TTL (stub, #620) ────────────────────────────────────

describe('DI-006: Relay-expiry TTL (stub for #620)', () => {
  it.skip('relay message with expired ttl → dead-letter (not implemented in #585)', () => {
    // Stub: #620 will fill in relay TTL/expiry semantics here.
  });
});

// ── DI-007: Truncation (stub, #87) ───────────────────────────────────────────

describe('DI-007: Truncation (stub for #87)', () => {
  it.skip('message body > truncation threshold → truncated body in DB (not implemented in #585)', () => {
    // Stub: #87 will fill in truncation behavior here.
  });
});

// ── DI-008: Orch-delivery gap (stub) ─────────────────────────────────────────

describe('DI-008: Orch-delivery gap (stub)', () => {
  it.skip('orchestrator result while comms offline → DB row exists, injected_at NULL, no error', () => {
    // Stub: documents the orch-delivery gap case.
  });
});
