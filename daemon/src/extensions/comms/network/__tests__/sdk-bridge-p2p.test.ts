/**
 * Regression tests for the /agent/p2p persistence-acknowledgement fix (kithkit#337)
 * and the 4xx-permanent / 5xx-transient retry-classification fix (todo #700).
 *
 * ── kithkit#337 fix ──────────────────────────────────────────────────────────
 * Bug: handleAgentP2P returned {ok:true} unconditionally, even when
 * handleIncomingP2P returned false (SDK unavailable / handler error).
 * This caused the sender SDK to report status='delivered' when the message
 * was never actually persisted — a false delivery confirmation.
 *
 * ── todo #700 / 4xx-permanent / 5xx-transient ────────────────────────────────
 * Bug: handleIncomingP2P returned a plain boolean, so the HTTP handler always
 * sent HTTP 500 on failure regardless of whether the failure was transient
 * (SDK not yet initialised — sender should retry) or permanent (SDK rejected
 * the envelope — retrying will not help and wastes resources).
 *
 * Fix: handleIncomingP2P now returns a P2PHandleResult discriminated union:
 *   { ok: true }                   → HTTP 200 (delivered)
 *   { ok: false, permanent: false } → HTTP 5xx (transient — SDK unavailable, retry)
 *   { ok: false, permanent: true }  → HTTP 4xx (permanent — bad envelope, no retry)
 *
 * Mutation-killer property: if the 4xx-permanent / 5xx-transient distinction is
 * removed (both failure paths return the same `permanent` value), the
 * "retry-classification" tests below go RED.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleIncomingP2P,
  _resetForTesting,
  _setNetworkForTesting,
} from '../sdk-bridge.js';
import type { WireEnvelope } from '../sdk-types.js';
import type { A2ANetworkClient } from '../sdk-types.js';

// ── Helpers ───────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<WireEnvelope> = {}): WireEnvelope {
  return {
    version: '1',
    type: 'direct',
    messageId: 'test-msg-id',
    sender: 'test-peer',
    recipient: 'local-agent',
    timestamp: new Date().toISOString(),
    payload: { ciphertext: 'abc', nonce: 'xyz' },
    signature: 'sig',
    ...overrides,
  } as WireEnvelope;
}

/** Minimal A2ANetworkClient stub — overrides the relevant methods per test. */
function makeStubNetwork(overrides: Partial<Pick<A2ANetworkClient, 'receiveMessage' | 'receiveGroupMessage'>> = {}): A2ANetworkClient {
  return {
    start: async () => {},
    stop: async () => {},
    on: () => {},
    receiveMessage: () => { /* success by default */ },
    receiveGroupMessage: async () => null,
    acceptContact: async () => {},
    rotateKey: async () => ({ ok: true }),
    send: async () => ({ ok: true, status: 'delivered' }),
    sendToGroup: async () => ({ ok: true }),
    communities: [],
    getCommunityManager: () => ({
      getActiveRelayType: () => 'primary' as const,
      getFailureCount: () => 0,
    }),
    requestContact: async () => ({ ok: true }),
    getPendingRequests: async () => [],
    denyContact: async () => {},
    removeContact: async () => {},
    getContacts: async () => [],
    checkPresence: async () => ({ online: false }),
    acceptGroupInvitation: async () => ({ ok: true }),
    ...overrides,
  } as unknown as A2ANetworkClient;
}

// ── persistence-failure tests ─────────────────────────────────

describe('handleIncomingP2P — persistence-failure returns {ok:false}', () => {
  beforeEach(() => {
    _resetForTesting(); // ensures _network = null
  });

  it('returns {ok:false} when SDK is not initialized (null _network)', async () => {
    // SDK not initialized = persistence-failure.
    // HTTP handler must respond with a 5xx so sender reports 'queued'.
    const result = await handleIncomingP2P(makeEnvelope());
    assert.equal(result.ok, false,
      'persistence-failure: must return ok:false when SDK not initialized');
  });

  it('returns {ok:false} when receiveMessage throws (DM envelope)', async () => {
    _setNetworkForTesting(makeStubNetwork({
      receiveMessage: () => { throw new Error('receive failed'); },
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'direct' }));
    assert.equal(result.ok, false,
      'persistence-failure: must return ok:false when receiveMessage throws');
  });

  it('returns {ok:false} when receiveGroupMessage throws (group envelope)', async () => {
    _setNetworkForTesting(makeStubNetwork({
      receiveGroupMessage: async () => { throw new Error('group receive failed'); },
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'group' }));
    assert.equal(result.ok, false,
      'persistence-failure: must return ok:false when receiveGroupMessage throws');
  });
});

// ── persistence-success tests ─────────────────────────────────

describe('handleIncomingP2P — persistence-success returns {ok:true}', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('returns {ok:true} when receiveMessage succeeds (DM envelope)', async () => {
    _setNetworkForTesting(makeStubNetwork()); // default receiveMessage does not throw

    const result = await handleIncomingP2P(makeEnvelope({ type: 'direct' }));
    assert.equal(result.ok, true,
      'persistence-success: must return ok:true after successful receiveMessage; ' +
      'HTTP handler must respond {ok:true} so sender reports delivered');
  });

  it('returns {ok:true} when receiveGroupMessage returns a message object', async () => {
    _setNetworkForTesting(makeStubNetwork({
      receiveGroupMessage: async () => ({
        messageId: 'gm-1',
        sender: 'test-peer',
        groupId: 'g1',
        payload: { text: 'hello' },
        verified: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'group', groupId: 'g1' }));
    assert.equal(result.ok, true,
      'persistence-success: must return ok:true after successful group receiveGroupMessage');
  });

  it('returns {ok:true} when receiveGroupMessage returns null (deduplication — not a failure)', async () => {
    // Dedup is intentional; the SDK already has this message. Still not a failure.
    _setNetworkForTesting(makeStubNetwork({
      receiveGroupMessage: async () => null,
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'group', groupId: 'g1' }));
    assert.equal(result.ok, true,
      'deduplication is not a persistence-failure: receiveGroupMessage returning null must still yield ok:true');
  });
});

// ── retry-classification tests (mutation-killer for todo #700) ───────────────
//
// These tests enforce the 4xx-permanent / 5xx-transient distinction.
// MUTATION: if both failure paths return the same `permanent` value, these tests
// go RED — one will fail on the permanent===false assertion, the other on
// permanent===true.

describe('handleIncomingP2P — retry classification (todo #700 / 4xx vs 5xx)', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('SDK unavailable (null _network) → permanent:false → maps to 5xx (transient, sender MUST retry)', async () => {
    // No network set — SDK not initialised.
    // Sender SDK should retry after the SDK comes up; permanent:false signals this.
    const result = await handleIncomingP2P(makeEnvelope());

    assert.equal(result.ok, false, 'SDK unavailable: result must be a failure');
    // Type-narrow to the failure variant before accessing .permanent
    assert.ok(!result.ok);
    assert.equal((result as { ok: false; permanent: boolean }).permanent, false,
      'SDK unavailable is TRANSIENT — permanent must be false so HTTP handler sends 5xx and sender retries');
  });

  it('SDK rejects envelope (receiveMessage throws) → permanent:true → maps to 4xx (permanent, sender MUST NOT retry)', async () => {
    // SDK is initialised but throws when receiving the envelope.
    // Bad envelope content won't improve on retry; permanent:true signals this.
    _setNetworkForTesting(makeStubNetwork({
      receiveMessage: () => { throw new Error('malformed ciphertext'); },
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'direct' }));

    assert.equal(result.ok, false, 'SDK rejection: result must be a failure');
    assert.ok(!result.ok);
    assert.equal((result as { ok: false; permanent: boolean }).permanent, true,
      'SDK envelope rejection is PERMANENT — permanent must be true so HTTP handler sends 4xx and sender does NOT retry');
  });

  it('SDK rejects group envelope (receiveGroupMessage throws) → permanent:true → maps to 4xx', async () => {
    _setNetworkForTesting(makeStubNetwork({
      receiveGroupMessage: async () => { throw new Error('bad group envelope'); },
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'group' }));

    assert.equal(result.ok, false, 'SDK group rejection: result must be a failure');
    assert.ok(!result.ok);
    assert.equal((result as { ok: false; permanent: boolean }).permanent, true,
      'SDK group envelope rejection is PERMANENT — permanent must be true so HTTP handler sends 4xx');
  });
});
