/**
 * t-209: Access control classifies senders correctly
 * t-210: Access control enforces rate limits per tier
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureAccessControl,
  classifySender,
  checkRateLimit,
  addSafeSender,
  blockSender,
  registerTier,
  getSafeSenders,
  getBlockedSenders,
  getTierLimit,
  SenderTier,
  _resetForTesting,
} from '../core/access-control.js';

describe('Access control classification (t-209)', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('classifies safe senders from config', () => {
    configureAccessControl({
      safeSenders: ['user-1', 'user-2'],
    });
    assert.equal(classifySender('user-1'), SenderTier.Safe);
    assert.equal(classifySender('user-2'), SenderTier.Safe);
  });

  it('classifies unknown senders', () => {
    configureAccessControl({
      safeSenders: ['user-1'],
    });
    assert.equal(classifySender('stranger'), SenderTier.Unknown);
  });

  it('classifies blocked senders', () => {
    configureAccessControl({
      safeSenders: ['user-1'],
      blockedSenders: ['bad-actor'],
    });
    assert.equal(classifySender('bad-actor'), SenderTier.Blocked);
  });

  it('addSafeSender promotes unknown to safe', () => {
    configureAccessControl({ safeSenders: [] });
    assert.equal(classifySender('stranger'), SenderTier.Unknown);
    addSafeSender('stranger');
    assert.equal(classifySender('stranger'), SenderTier.Safe);
  });

  it('addSafeSender removes from blocked list', () => {
    configureAccessControl({
      safeSenders: [],
      blockedSenders: ['user-x'],
    });
    assert.equal(classifySender('user-x'), SenderTier.Blocked);
    addSafeSender('user-x');
    assert.equal(classifySender('user-x'), SenderTier.Safe);
    assert.ok(!getBlockedSenders().includes('user-x'));
  });

  it('blockSender blocks and removes from safe list', () => {
    configureAccessControl({ safeSenders: ['user-1'] });
    assert.equal(classifySender('user-1'), SenderTier.Safe);
    blockSender('user-1');
    assert.equal(classifySender('user-1'), SenderTier.Blocked);
    assert.ok(!getSafeSenders().includes('user-1'));
  });

  it('custom tier classifier takes priority', () => {
    configureAccessControl({ safeSenders: ['user-1'] });
    registerTier('3rd-party', (senderId) => {
      if (senderId.startsWith('3p-')) return 'third-party-approved';
      return null;
    });
    assert.equal(classifySender('3p-alice'), 'third-party-approved');
    assert.equal(classifySender('user-1'), SenderTier.Safe); // still works for non-custom
  });

  it('multiple custom classifiers checked in order', () => {
    configureAccessControl({ safeSenders: [] });
    registerTier('vip', (senderId) => {
      if (senderId === 'vip-1') return 'vip';
      return null;
    });
    registerTier('pending', (senderId) => {
      if (senderId.startsWith('pending-')) return 'pending-approval';
      return null;
    });
    assert.equal(classifySender('vip-1'), 'vip');
    assert.equal(classifySender('pending-alice'), 'pending-approval');
    assert.equal(classifySender('random'), SenderTier.Unknown);
  });

  it('getSafeSenders returns current list', () => {
    configureAccessControl({ safeSenders: ['a', 'b'] });
    const senders = getSafeSenders();
    assert.ok(senders.includes('a'));
    assert.ok(senders.includes('b'));
    assert.equal(senders.length, 2);
  });

  it('getTierLimit returns config for tier', () => {
    configureAccessControl({ safeSenders: [] });
    const safeLimit = getTierLimit(SenderTier.Safe);
    assert.ok(safeLimit);
    assert.equal(safeLimit.maxPerMinute, 100);

    const unknownLimit = getTierLimit(SenderTier.Unknown);
    assert.ok(unknownLimit);
    assert.equal(unknownLimit.maxPerMinute, 5);
  });
});

describe('Access control rate limiting (t-210)', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('safe senders allowed up to limit', () => {
    configureAccessControl({
      safeSenders: ['user-1'],
      tierLimits: { [SenderTier.Safe]: { maxPerMinute: 100 } },
    });

    // 10 requests should all be allowed for safe sender
    for (let i = 0; i < 10; i++) {
      const result = checkRateLimit('user-1');
      assert.equal(result.allowed, true, `Request ${i + 1} should be allowed`);
      assert.equal(result.tier, SenderTier.Safe);
    }
  });

  it('unknown senders rate limited after threshold', () => {
    configureAccessControl({
      safeSenders: [],
      tierLimits: { [SenderTier.Unknown]: { maxPerMinute: 5 } },
    });

    // First 5 should be allowed
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit('stranger');
      assert.equal(result.allowed, true, `Request ${i + 1} should be allowed`);
    }

    // 6th should be rate limited
    const result = checkRateLimit('stranger');
    assert.equal(result.allowed, false, 'Request 6 should be rate limited');
    assert.equal(result.tier, SenderTier.Unknown);
  });

  it('blocked senders always rate limited (maxPerMinute: 0)', () => {
    configureAccessControl({
      safeSenders: [],
      blockedSenders: ['bad-actor'],
    });

    const result = checkRateLimit('bad-actor');
    assert.equal(result.allowed, false);
    assert.equal(result.tier, SenderTier.Blocked);
  });

  it('rate limit result includes remaining count', () => {
    configureAccessControl({
      safeSenders: [],
      tierLimits: { [SenderTier.Unknown]: { maxPerMinute: 3 } },
    });

    const r1 = checkRateLimit('test-user');
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 2); // 3 max - 1 used = 2 remaining

    const r2 = checkRateLimit('test-user');
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 1); // 3 max - 2 used = 1 remaining

    const r3 = checkRateLimit('test-user');
    assert.equal(r3.allowed, true);
    assert.equal(r3.remaining, 0); // last one, 0 remaining

    const r4 = checkRateLimit('test-user');
    assert.equal(r4.allowed, false);
  });

  it('custom tier limits can be configured', () => {
    configureAccessControl({
      safeSenders: [],
      tierLimits: {
        [SenderTier.Safe]: { maxPerMinute: 200 },
        [SenderTier.Unknown]: { maxPerMinute: 2 },
        'third-party': { maxPerMinute: 10 },
      },
    });

    const safeLimit = getTierLimit(SenderTier.Safe);
    assert.equal(safeLimit?.maxPerMinute, 200);

    const unknownLimit = getTierLimit(SenderTier.Unknown);
    assert.equal(unknownLimit?.maxPerMinute, 2);

    const tpLimit = getTierLimit('third-party');
    assert.equal(tpLimit?.maxPerMinute, 10);
  });

  it('different senders have independent rate limits', () => {
    configureAccessControl({
      safeSenders: [],
      tierLimits: { [SenderTier.Unknown]: { maxPerMinute: 2 } },
    });

    // sender A uses 2 requests
    assert.equal(checkRateLimit('sender-a').allowed, true);
    assert.equal(checkRateLimit('sender-a').allowed, true);
    assert.equal(checkRateLimit('sender-a').allowed, false);

    // sender B should still have their own quota
    assert.equal(checkRateLimit('sender-b').allowed, true);
    assert.equal(checkRateLimit('sender-b').allowed, true);
    assert.equal(checkRateLimit('sender-b').allowed, false);
  });
});
