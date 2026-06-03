/**
 * email-check.ts — triageEmail precedence regression tests
 *
 * Guards the fix for issues #640/#1786/#1762:
 *   Sender-scoped suppression rules (auto_read, junk, newsletters) must take
 *   precedence over VIP/keyword promotion on the combined from+subject text.
 *
 * Regression guard: internal@service-now.com with a subject that contains
 *   a VIP keyword ("servos") AND an urgency keyword ("Error") must classify
 *   as 'auto_read', NOT 'vip'.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { triageEmail, type TriageCategory } from '../email-check.js';
import type { EmailMessage } from '../../../comms/adapters/email/graph-provider.js';

// ── Helpers ───────────────────────────────────────────────────

function makeMsg(from: string, subject: string): EmailMessage {
  return { id: 'test-id', from, subject, date: new Date().toISOString(), isRead: false };
}

const BASE_RULES = {
  vip: ['servos', 'boss@company.com'],
  junk: ['marketing@', 'noreply@spam'],
  newsletters: ['substack.com', 'newsletter@'],
  receipts: ['receipt', 'order confirmation'],
  auto_read: ['internal@service-now.com', 'notifications@github.com'],
};

// ── Tests ─────────────────────────────────────────────────────

describe('triageEmail — sender-scoped suppression precedence', () => {

  // ── Regression guard (the original over-fire case) ─────────

  it('SN notification with VIP keyword in subject → auto_read (regression guard)', () => {
    // internal@service-now.com is in auto_read by sender.
    // Subject contains "Servos" (matches config.vip) and "Error" (urgency keyword).
    // OLD behaviour: classified 'vip' → NOTIFY OWNER [urgent] (wrong).
    // NEW behaviour: sender match wins → 'auto_read'.
    const msg = makeMsg(
      'internal@service-now.com',
      'CS9287367 - Incident - Error processing request | Servos LLC',
    );
    const result: TriageCategory = triageEmail(msg, BASE_RULES);
    assert.strictEqual(result, 'auto_read',
      'auto_read sender must not be promoted to vip by subject keyword');
  });

  // ── auto_read sender suppression family ────────────────────

  it('auto_read sender + urgency keyword in subject → auto_read', () => {
    const msg = makeMsg('internal@service-now.com', 'CRITICAL: system alert [urgent]');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'auto_read');
  });

  it('auto_read sender + VIP + urgency keywords in subject → auto_read', () => {
    const msg = makeMsg('notifications@github.com', 'servos security alert — action required');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'auto_read');
  });

  // ── junk sender suppression ────────────────────────────────

  it('junk sender + VIP keyword in subject → junk', () => {
    const msg = makeMsg('marketing@bigstore.com', 'Servos exclusive offer just for you!');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'junk');
  });

  it('junk sender + no VIP keyword → junk', () => {
    const msg = makeMsg('noreply@spam.example.com', 'Win a prize today');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'junk');
  });

  // ── newsletter sender suppression ─────────────────────────

  it('newsletter sender + VIP keyword in subject → newsletter', () => {
    const msg = makeMsg('digest@substack.com', 'Servos weekly digest: top AI stories');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'newsletter');
  });

  it('newsletter sender + urgency keyword in subject → newsletter', () => {
    const msg = makeMsg('newsletter@weekly.io', 'CRITICAL: breaking news this week');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'newsletter');
  });

  // ── Regression — genuine VIP must still work ───────────────

  it('genuine VIP sender NOT in any suppression list + VIP keyword → vip', () => {
    // boss@company.com is in config.vip (via email match) and NOT in any suppression list.
    const msg = makeMsg('boss@company.com', 'Quarterly review — please respond');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'vip');
  });

  it('VIP keyword in subject only, sender not in any list → vip', () => {
    const msg = makeMsg('someone@external.com', 'Regarding Servos contract renewal');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'vip');
  });

  it('VIP keyword in sender address, not suppressed → vip', () => {
    const msg = makeMsg('contact@servos.io', 'Hello from the team');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'vip');
  });

  // ── Other categories still work ────────────────────────────

  it('receipt keyword in subject, sender not suppressed → receipt', () => {
    const msg = makeMsg('orders@amazon.com', 'Your order confirmation #12345');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'receipt');
  });

  it('junk keyword in subject, sender not suppressed → junk', () => {
    // "noreply@spam" pattern appears in the combined from+subject text
    const msg = makeMsg('bulk@bigstore.com', 'Forwarded via noreply@spam relay');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'junk');
  });

  it('no rules match at all → unknown', () => {
    const msg = makeMsg('friend@personal.com', 'Lunch plans for tomorrow?');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'unknown');
  });

  // ── Edge cases ─────────────────────────────────────────────

  it('empty rules — all messages return unknown', () => {
    const empty = { vip: [], junk: [], newsletters: [], receipts: [], auto_read: [] };
    const msg = makeMsg('internal@service-now.com', 'CS9287367 Error | Servos LLC');
    assert.strictEqual(triageEmail(msg, empty), 'unknown');
  });

  it('auto_read sender with receipts keyword in subject → auto_read (sender wins over receipts)', () => {
    const msg = makeMsg('internal@service-now.com', 'Your receipt for incident CS123');
    assert.strictEqual(triageEmail(msg, BASE_RULES), 'auto_read');
  });
});
