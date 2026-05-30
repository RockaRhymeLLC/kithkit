/**
 * Delivery Integrity Test Harness
 *
 * Shared infrastructure for #585, #620, #87, and the orch-delivery gap.
 *
 * Tests the core delivery invariants for LAN-inbound A2A messages:
 *
 *   DI-001 — LAN-no-persist (#585 bug, RED before fix)
 *   DI-002 — LAN-persist-success
 *   DI-003 — LAN-session-dead-persist
 *   DI-004 — LAN-inject-idempotent
 *   DI-005 — LAN-inject-error-dead-letter
 *   DI-006 — Relay-expiry TTL (stub, #620)
 *   DI-007 — Truncation (stub, #87)
 *   DI-008 — Orch-delivery gap (stub)
 *
 * Cases DI-006, DI-007, DI-008 are .skip stubs — they reserve harness slots
 * and document the contract for later PRs without blocking #585.
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
// This test proves the bug exists (RED) before the fix is applied.
// After Commit 3 (persist-on-receive), this test turns GREEN.

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
    // Before fix: rows.length === 0 (RED)
    // After fix:  rows.length === 1 (GREEN)
    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'DB row must be present even when inject fails');
    assert.ok(rows[0]!.body.includes('DI-001 sentinel') || rows[0]!.body.includes('r2d2'),
      'DB row body should contain message content');
  });
});

// ── DI-002: LAN-persist-success ───────────────────────────────
//
// Happy path: message arrives, inject succeeds.
// DB row exists AND injected_at IS NOT NULL.
// Goes GREEN after Commit 4 (injected_at stamp).

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
// Session is absent (not a genuine error — message pending for later delivery).
// DB row exists AND injected_at IS NULL AND log.info emitted (not log.error).
// Goes GREEN after Commit 4.

describe('DI-003: LAN session-dead — DB row exists, injected_at NULL (pending delivery)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('session absent: DB row exists with injected_at NULL (pending, not dead-letter)', async () => {
    // Session doesn't exist → inject returns false; commsSessionExists → false
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
// DB row already has injected_at set; same message arrives again within dedup window.
// inject must NOT be called a second time; injected_at must be unchanged.
// Goes GREEN after Commit 4.

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

    // Second delivery of the same message (within dedup window — same body+from+to+type)
    await handleAgentMessage(msg);
    const rows2 = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    // Dedup returns same row; no new insert
    assert.equal(rows2.length, 1, 'dedup: still only one DB row');
    // injected_at must not have changed
    assert.equal(rows2[0]!.injected_at, firstInjectedAt, 'injected_at must not change on re-delivery');
    // Inject should have been called once (first call), not again (dedup path returns early)
    assert.equal(injectCallCount, firstCallCount, 'inject must not be called again on dedup path');
  });
});

// ── DI-005: LAN-inject-error-dead-letter ─────────────────────
//
// Session exists but inject fails (execFileSync threw — e.g. tmux error).
// DB row exists; injected_at IS NULL; log.error emitted (dead-letter observable).
// Goes GREEN after Commit 5.

describe('DI-005: LAN inject-error → dead-letter ERROR log, DB row with NULL injected_at', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('inject fails despite session alive: DB row exists, injected_at NULL', async () => {
    // Session "exists" but inject fails anyway
    _setTmuxInjectorForTesting(() => false);
    _setCommsSessionExistsForTesting(() => true);

    const msg = makeTextMsg({ from: 'r2d2', text: 'DI-005 sentinel' });
    await handleAgentMessage(msg);

    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'DB row must exist even on inject failure');
    assert.equal(rows[0]!.injected_at, null,
      'injected_at must be NULL when inject failed (not yet delivered)');
    // log.error assertion: we verify this via the DB state + null injected_at
    // (log.error output is not easily capturable without a log mock; the combination
    // of "session alive + injected_at NULL" is the observable dead-letter state)
  });
});

// ── DI-009: to_agent recipient derivation ────────────────────
//
// Verifies that LAN inbound messages always persist with to_agent='comms'.
//
// Rationale (path 2b, BMO ruling #585):
//   AgentMessage carries NO to/recipient/target field — only from, type,
//   text, status, action, task, context, messageId, timestamp.  The
//   /agent/message endpoint is a comms-inbound-only path by design;
//   peers cannot LAN-target the orchestrator through it.  Hardcoding
//   to:'comms' is correct and forced — there is no recipient field to derive
//   from.  This test documents and guards that invariant.
//
// A comms-targeted inbound → to_agent='comms'.
// An orchestrator-bound peer message CANNOT arrive via handleAgentMessage
// (no recipient field exists in the LAN protocol), so no orchestrator-
// targeted derive case exists on this path.

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

    // AgentMessage has [key: string]: unknown — confirm that even if a sender
    // includes a spurious 'to' field it is NOT used to derive the recipient
    // (the derive path does not exist; to:'comms' is hardcoded for this endpoint).
    const msg: AgentMessage = {
      from: 'r2d2',
      type: 'text',
      text: 'DI-009 no-recipient-field',
      messageId: `test-di009-${Date.now()}`,
      timestamp: new Date().toISOString(),
      // No 'to' field — mirrors the real LAN protocol
    };
    await handleAgentMessage(msg);

    const rows = query<MessageRow>('SELECT * FROM messages WHERE from_agent = ?', 'r2d2');
    assert.equal(rows.length, 1, 'DB row must exist');
    assert.equal(rows[0]!.to_agent, 'comms',
      'to_agent must default to "comms" when no recipient field present');
  });
});

// ── DI-006: Relay-expiry TTL (stub, #620) ────────────────────
//
// Relay message with expired TTL — delivery attempted, dead-letter reached.
// NOT implemented in #585 — stub reserved for #620.

describe('DI-006: Relay-expiry TTL (stub for #620)', () => {
  it.skip('relay message with expired ttl → dead-letter (not implemented in #585)', () => {
    // Stub: #620 will fill in relay TTL/expiry semantics here.
    // Setup: relay message with ttl that has elapsed
    // Assert: dead-letter state reached, log.error emitted
  });
});

// ── DI-007: Truncation (stub, #87) ───────────────────────────
//
// Message body > truncation threshold — truncation behavior asserted.
// NOT implemented in #585 — stub reserved for #87.

describe('DI-007: Truncation (stub for #87)', () => {
  it.skip('message body > truncation threshold → truncated body in DB (not implemented in #585)', () => {
    // Stub: #87 will fill in truncation behavior here.
    // Setup: message with body > MAX_INJECT_LENGTH (4000 chars)
    // Assert: DB body is truncated; original available in metadata
  });
});

// ── DI-008: Orch-delivery gap (stub) ─────────────────────────
//
// Orchestrator sends result message while comms is offline.
// DB row exists; injected_at IS NULL; no error log (not dead-letter, just pending).
// Stub — behavior is similar to DI-003 but for orch→comms path.

describe('DI-008: Orch-delivery gap (stub)', () => {
  it.skip('orchestrator result while comms offline → DB row exists, injected_at NULL, no error', () => {
    // Stub: documents the orch-delivery gap case.
    // When comms session is dead, orchestrator result messages should persist
    // to DB and be delivered when comms returns. No error log (just pending).
    // Currently handled by the message-delivery scheduler task.
  });
});
