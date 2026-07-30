/**
 * Regression tests for message-delivery.ts — orchestrator injection fix.
 *
 * Covers:
 *   - Bug1 fix: messages to_agent='orchestrator' are now fetched from DB
 *   - Bug2 fix: getLiveSessions() now includes 'orchestrator' when orch session is alive
 *     and getOrchestratorState() === 'waiting' (idle guard, issue #135)
 *   - Defer-not-expire: busy orch (state='active') defers messages without consuming retry budget
 *   - Absent/dead orch: normal retry/expire behavior preserved
 *   - Regression guard: comms delivery path is unaffected by the orch state check
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query, exec } from '../../../core/db.js';
import {
  _resetRetriesForTesting,
  _getRetryCount,
  _setDeliveryDepsForTesting,
  _deliverMessagesForTesting,
} from '../message-delivery.js';
import { _getCommsSession, _getOrchestratorSession, MAX_INJECT_LENGTH } from '../../../agents/tmux.js';

// ── Helpers ───────────────────────────────────────────────────

interface MsgRow {
  id: number;
  to_agent: string;
  processed_at: string | null;
  read_at: string | null;
  notified_at: string | null;
  metadata: string | null;
}

function insertMessage(opts: {
  from?: string;
  to: string;
  type?: string;
  body?: string;
}): number {
  const result = exec(
    `INSERT INTO messages (from_agent, to_agent, type, body) VALUES (?, ?, ?, ?)`,
    opts.from ?? 'comms',
    opts.to,
    opts.type ?? 'task',
    opts.body ?? 'test body',
  );
  return result.lastInsertRowid as number;
}

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-msg-delivery-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  _resetRetriesForTesting();
}

function teardownDb(): void {
  _setDeliveryDepsForTesting(null); // restore production deps
  _resetRetriesForTesting();
  _resetDbForTesting();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe('message-delivery: orchestrator injection (bug fix)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('delivers message to orchestrator when orch session is alive and state=waiting', async () => {
    // Insert undelivered message addressed to orchestrator
    const msgId = insertMessage({ from: 'comms', to: 'orchestrator', body: 'do the thing' });

    const injected: Array<{ agentId: string; text: string }> = [];

    _setDeliveryDepsForTesting({
      listSessions: () => [_getCommsSession(), _getOrchestratorSession()],
      injectMessage: (agentId, text) => {
        injected.push({ agentId, text });
        return true;
      },
      orchState: () => 'waiting', // idle at prompt — safe to inject
    });

    await _deliverMessagesForTesting();

    // injectMessage must have been called for orchestrator
    const orchCall = injected.find(c => c.agentId === 'orchestrator');
    assert.ok(orchCall, 'injectMessage was not called for orchestrator');

    // DB record must have all three timestamps set
    const rows = query<MsgRow>('SELECT id, to_agent, processed_at, read_at, notified_at FROM messages WHERE id = ?', msgId);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].processed_at, 'processed_at should be set after delivery');
    assert.ok(rows[0].read_at, 'read_at should be set after delivery');
    assert.ok(rows[0].notified_at, 'notified_at should be set after delivery');
  });

  it('delivers message to comms (regression guard — existing path unaffected)', async () => {
    const msgId = insertMessage({ from: 'orchestrator', to: 'comms', body: 'task done' });

    const injected: Array<{ agentId: string }> = [];

    _setDeliveryDepsForTesting({
      listSessions: () => [_getCommsSession(), _getOrchestratorSession()],
      injectMessage: (agentId, _text) => {
        injected.push({ agentId });
        return true;
      },
      orchState: () => 'waiting', // orch state is checked when orch session is in list
    });

    await _deliverMessagesForTesting();

    const commsCall = injected.find(c => c.agentId === 'comms');
    assert.ok(commsCall, 'injectMessage was not called for comms');

    const rows = query<MsgRow>('SELECT id, processed_at, read_at, notified_at FROM messages WHERE id = ?', msgId);
    assert.ok(rows[0].processed_at, 'comms message processed_at should be set');
    assert.ok(rows[0].read_at, 'comms message read_at should be set');
    assert.ok(rows[0].notified_at, 'comms message notified_at should be set');
  });

  it('increments retry count (not expire) on first miss when orch session absent', async () => {
    const msgId = insertMessage({ from: 'comms', to: 'orchestrator', body: 'nudge' });

    _setDeliveryDepsForTesting({
      // orch session NOT present — only comms is alive; orchState never called
      listSessions: () => [_getCommsSession()],
      injectMessage: (_agentId, _text) => true,
    });

    await _deliverMessagesForTesting();

    // Message should NOT be delivered
    const rows = query<MsgRow>('SELECT processed_at FROM messages WHERE id = ?', msgId);
    assert.equal(rows[0].processed_at, null, 'message should not be marked processed when session absent');

    // retry count should be 1 (incremented, not expired)
    const retries = _getRetryCount(msgId);
    assert.equal(retries, 1, 'retry count should be 1 after first failed attempt');
  });

  // ── Idle-guard tests (issue #135) ─────────────────────────────

  it('injects only a SHORT unread ping (not full content) when orch is state=active (busy) — todo 2769', async () => {
    const msgId = insertMessage({ from: 'comms', to: 'orchestrator', body: 'URGENT-SCOPE-REDIRECT-BODY' });

    const injected: Array<{ agentId: string; text: string }> = [];

    _setDeliveryDepsForTesting({
      listSessions: () => [_getCommsSession(), _getOrchestratorSession()],
      injectMessage: (agentId, text) => {
        injected.push({ agentId, text });
        return true;
      },
      orchState: () => 'active', // mid-run — full content must NOT deliver, but a ping must
    });

    await _deliverMessagesForTesting();

    // Exactly one orchestrator inject: the busy ping — NOT the message body
    const orchCalls = injected.filter(c => c.agentId === 'orchestrator');
    assert.equal(orchCalls.length, 1, 'exactly one busy ping should be injected');
    assert.ok(orchCalls[0].text.includes('unread message'), 'ping should mention unread messages');
    assert.ok(!orchCalls[0].text.includes('URGENT-SCOPE-REDIRECT-BODY'), 'ping must not contain full message body');

    // Message must remain pending (processed_at = null) — full delivery happens at idle
    const rows = query<MsgRow>('SELECT processed_at FROM messages WHERE id = ?', msgId);
    assert.equal(rows[0].processed_at, null, 'message should remain pending when orch is busy');

    // Second tick: no re-ping for the same message (busy_pinged_at set)
    await _deliverMessagesForTesting();
    assert.equal(
      injected.filter(c => c.agentId === 'orchestrator').length,
      1,
      'no duplicate ping for an already-pinged message',
    );
  });

  it('defers message without consuming retry budget across 3+ busy ticks, then delivers when idle', async () => {
    const msgId = insertMessage({ from: 'comms', to: 'orchestrator', body: 'important task' });

    const injected: Array<{ agentId: string }> = [];
    let orchStateReturn: 'active' | 'waiting' | 'dead' = 'active';

    _setDeliveryDepsForTesting({
      listSessions: () => [_getCommsSession(), _getOrchestratorSession()],
      injectMessage: (agentId, _text) => {
        injected.push({ agentId });
        return true;
      },
      orchState: () => orchStateReturn,
    });

    // Run 4 consecutive ticks while orch is busy (active)
    for (let tick = 1; tick <= 4; tick++) {
      await _deliverMessagesForTesting();

      // After each busy tick: message must remain pending
      const rows = query<MsgRow>('SELECT processed_at FROM messages WHERE id = ?', msgId);
      assert.equal(rows[0].processed_at, null, `tick ${tick}: message should stay pending while orch is busy`);

      // Retry budget must NOT be consumed — stays at 0
      const retries = _getRetryCount(msgId);
      assert.equal(retries, 0, `tick ${tick}: retry count must not increase while orch is busy (deferred)`);

      // Exactly ONE busy ping total (fired on tick 1, deduped afterward) — the
      // full message content must never be injected while busy (todo 2769).
      assert.equal(
        injected.filter(c => c.agentId === 'orchestrator').length,
        1,
        `tick ${tick}: exactly one busy ping across busy ticks (no re-ping, no full delivery)`,
      );
    }

    // Now orch becomes idle
    orchStateReturn = 'waiting';
    await _deliverMessagesForTesting();

    // Message must now be delivered in full (ping + full delivery = 2 orch injects)
    const orchCalls = injected.filter(c => c.agentId === 'orchestrator');
    assert.equal(orchCalls.length, 2, 'full delivery should follow once orch is idle');

    const rows = query<MsgRow>('SELECT processed_at, read_at, notified_at FROM messages WHERE id = ?', msgId);
    assert.ok(rows[0].processed_at, 'processed_at should be set after delivery when orch becomes idle');
    assert.ok(rows[0].read_at, 'read_at should be set after delivery when orch becomes idle');
    assert.ok(rows[0].notified_at, 'notified_at should be set after delivery when orch becomes idle');
  });

  it('consumes retry budget and eventually expires when orch session is absent/dead', async () => {
    const msgId = insertMessage({ from: 'comms', to: 'orchestrator', body: 'will never arrive' });

    _setDeliveryDepsForTesting({
      // Orch session not in list at all — state never checked
      listSessions: () => [_getCommsSession()],
      injectMessage: (_agentId, _text) => true,
    });

    // Tick 1 — retry count becomes 1
    await _deliverMessagesForTesting();
    assert.equal(_getRetryCount(msgId), 1, 'retry count should be 1 after tick 1 (session absent)');
    let rows = query<MsgRow>('SELECT processed_at FROM messages WHERE id = ?', msgId);
    assert.equal(rows[0].processed_at, null, 'should still be pending after tick 1');

    // Tick 2 — retry count becomes 2
    await _deliverMessagesForTesting();
    assert.equal(_getRetryCount(msgId), 2, 'retry count should be 2 after tick 2 (session absent)');
    rows = query<MsgRow>('SELECT processed_at FROM messages WHERE id = ?', msgId);
    assert.equal(rows[0].processed_at, null, 'should still be pending after tick 2');

    // Tick 3 — hits MAX_RETRIES (3), message is expired
    await _deliverMessagesForTesting();
    rows = query<MsgRow>('SELECT processed_at, metadata FROM messages WHERE id = ?', msgId);
    assert.ok(rows[0].processed_at, 'processed_at should be set on expiry');
    const meta = JSON.parse(rows[0].metadata ?? '{}');
    assert.equal(meta.expired, true, 'metadata.expired should be true');
    assert.equal(meta.reason, 'max_retries_exceeded', 'metadata.reason should be max_retries_exceeded');
  });

  it('does NOT inject and does NOT set processed_at when orch session present but state=dead inside orch check', async () => {
    // This covers the edge case: listSessions reports the orch session name present,
    // but getOrchestratorState() returns 'dead' (pane process exited between the two calls).
    // Result: orch is treated as absent — retry budget is consumed, not deferred.
    const msgId = insertMessage({ from: 'comms', to: 'orchestrator', body: 'edge case' });

    const injected: Array<{ agentId: string }> = [];

    _setDeliveryDepsForTesting({
      listSessions: () => [_getCommsSession(), _getOrchestratorSession()],
      injectMessage: (agentId, _text) => {
        injected.push({ agentId });
        return true;
      },
      orchState: () => 'dead', // session listed but pane process dead
    });

    await _deliverMessagesForTesting();

    // Should NOT inject
    assert.equal(injected.filter(c => c.agentId === 'orchestrator').length, 0,
      'should not inject when state=dead');

    // Should consume retry budget (treated as absent, not deferred)
    assert.equal(_getRetryCount(msgId), 1, 'retry count should increment when state=dead (treated as absent)');

    // Message stays pending (not yet at MAX_RETRIES)
    const rows = query<MsgRow>('SELECT processed_at FROM messages WHERE id = ?', msgId);
    assert.equal(rows[0].processed_at, null, 'message should remain pending on first dead-state miss');
  });
});

// ── Batch-overflow tests ────────────────────────────────────────
//
// Reproduces the message-loss defect: a batch of undelivered messages whose
// concatenated content exceeds the tmux inject cap (MAX_INJECT_LENGTH) used
// to be joined into ONE string, injected as a single unit, and then EVERY
// message in the batch was marked processed_at/read_at/notified_at —
// including messages whose content never actually landed in the injected
// text because the tmux layer's own cap silently sliced it off.
//
// THE TRAP: asserting only on messages.body (which is always complete —
// storage never truncates) proves nothing about delivery. These tests
// assert on processed_at/read_at (must stay NULL for anything not actually
// injected) and on the injected text's length against the cap — the only
// signals that actually distinguish "delivered" from "dropped but marked
// delivered anyway".
describe('message-delivery: batch overflow does not mark undelivered messages as delivered', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('withholds messages that do not fit in the batch, and redelivers them on the next cycle', async () => {
    // Three messages whose combined content overflows MAX_INJECT_LENGTH once
    // batched: two fit together, the third does not.
    const bigBody = 'x'.repeat(1500);
    const msg1 = insertMessage({ to: 'comms', body: bigBody });
    const msg2 = insertMessage({ to: 'comms', body: bigBody });
    const msg3 = insertMessage({ to: 'comms', body: bigBody });

    const injected: Array<{ agentId: string; text: string }> = [];

    _setDeliveryDepsForTesting({
      listSessions: () => [_getCommsSession(), _getOrchestratorSession()],
      injectMessage: (agentId, text) => {
        injected.push({ agentId, text });
        return true; // simulate a successful tmux injection of whatever text we were given
      },
    });

    await _deliverMessagesForTesting();

    const commsCalls = injected.filter(c => c.agentId === 'comms');
    assert.equal(commsCalls.length, 1, 'exactly one batch injection to comms this cycle');

    // The text actually sent to the injection layer must respect the cap —
    // the caller must have sized the batch BEFORE sending, not after.
    assert.ok(
      commsCalls[0].text.length <= MAX_INJECT_LENGTH,
      `injected text (${commsCalls[0].text.length} chars) must not exceed MAX_INJECT_LENGTH (${MAX_INJECT_LENGTH})`,
    );

    const rows = query<MsgRow>(
      'SELECT id, processed_at, read_at, notified_at FROM messages WHERE id IN (?, ?, ?) ORDER BY id ASC',
      msg1, msg2, msg3,
    );
    const byId = new Map(rows.map(r => [r.id, r]));

    // The withheld message must NOT be marked delivered — it was never in
    // the injected text. This is the core assertion the defect violates.
    const third = byId.get(msg3)!;
    assert.equal(third.processed_at, null, 'withheld message must keep processed_at NULL');
    assert.equal(third.read_at, null, 'withheld message must keep read_at NULL');
    assert.equal(third.notified_at, null, 'withheld message must keep notified_at NULL');

    // At least the first message (which always fits) must have been
    // delivered — this batch isn't dropped wholesale, only the overflow.
    const first = byId.get(msg1)!;
    assert.ok(first.processed_at, 'first message that fits must be marked delivered');
    assert.ok(first.read_at, 'first message that fits must be marked read');

    // Next delivery cycle: the withheld message is still undelivered, so it
    // must be picked up and actually delivered — proving it was queued for
    // retry rather than silently lost.
    await _deliverMessagesForTesting();
    const rows2 = query<MsgRow>('SELECT processed_at FROM messages WHERE id = ?', msg3);
    assert.ok(rows2[0].processed_at, 'withheld message must be delivered on the next cycle');
  });

  it('injects only a marker mentioning the withheld count, not the withheld content', async () => {
    const bigBody = 'x'.repeat(1500);
    const sentinel = 'WITHHELD-SENTINEL-CONTENT';
    insertMessage({ to: 'comms', body: bigBody });
    insertMessage({ to: 'comms', body: bigBody });
    // Large enough (bigBody + sentinel) that it still can't fit alongside the
    // first two — without this it'd be small enough to squeeze in and the
    // batch wouldn't overflow at all, defeating the point of this test.
    insertMessage({ to: 'comms', body: `${bigBody}-${sentinel}` });

    const injected: Array<{ agentId: string; text: string }> = [];

    _setDeliveryDepsForTesting({
      listSessions: () => [_getCommsSession(), _getOrchestratorSession()],
      injectMessage: (agentId, text) => {
        injected.push({ agentId, text });
        return true;
      },
    });

    await _deliverMessagesForTesting();

    const text = injected.find(c => c.agentId === 'comms')!.text;
    assert.ok(!text.includes(sentinel), 'withheld message body must not appear in the injected text');
    assert.match(text, /\b1\b.*withheld|withheld.*\b1\b/i, 'marker must report the withheld count (1)');
  });
});
