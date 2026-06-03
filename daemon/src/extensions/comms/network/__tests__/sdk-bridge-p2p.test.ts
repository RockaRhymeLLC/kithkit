/**
 * Regression tests for the /agent/p2p persistence-acknowledgement fix.
 *
 * Bug: handleAgentP2P returned {ok:true} unconditionally, even when
 * handleIncomingP2P returned false (SDK unavailable / handler error).
 * This caused the sender SDK to report status='delivered' when the message
 * was never actually persisted — a false delivery confirmation.
 *
 * Fix (daemon companion to kithkit-a2a-client PR #5, delivery-integrity
 * cluster #585/#620/#124): handleAgentP2P now uses the return value of
 * handleIncomingP2P to drive the HTTP response:
 *   - false => HTTP 500 {ok:false} => sender SDK reports 'queued' (not delivered)
 *   - true  => HTTP 200 {ok:true}  => sender SDK reports 'delivered'
 *
 * These tests verify that handleIncomingP2P signals the correct boolean
 * semantics that the HTTP handler relies on.
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

describe('handleIncomingP2P — persistence-failure returns false', () => {
  beforeEach(() => {
    _resetForTesting(); // ensures _network = null
  });

  it('returns false when SDK is not initialized (null _network)', async () => {
    // SDK not initialized = persistence-failure.
    // HTTP handler must respond {ok:false, status:500} so sender reports 'queued'.
    const result = await handleIncomingP2P(makeEnvelope());
    assert.equal(result, false,
      'persistence-failure: must return false when SDK not initialized');
  });

  it('returns false when receiveMessage throws (DM envelope)', async () => {
    _setNetworkForTesting(makeStubNetwork({
      receiveMessage: () => { throw new Error('receive failed'); },
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'direct' }));
    assert.equal(result, false,
      'persistence-failure: must return false when receiveMessage throws');
  });

  it('returns false when receiveGroupMessage throws (group envelope)', async () => {
    _setNetworkForTesting(makeStubNetwork({
      receiveGroupMessage: async () => { throw new Error('group receive failed'); },
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'group' }));
    assert.equal(result, false,
      'persistence-failure: must return false when receiveGroupMessage throws');
  });
});

// ── persistence-success tests ─────────────────────────────────

describe('handleIncomingP2P — persistence-success returns true', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('returns true when receiveMessage succeeds (DM envelope)', async () => {
    _setNetworkForTesting(makeStubNetwork()); // default receiveMessage does not throw

    const result = await handleIncomingP2P(makeEnvelope({ type: 'direct' }));
    assert.equal(result, true,
      'persistence-success: must return true after successful receiveMessage; ' +
      'HTTP handler must respond {ok:true} so sender reports delivered');
  });

  it('returns true when receiveGroupMessage returns a message object', async () => {
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
    assert.equal(result, true,
      'persistence-success: must return true after successful group receiveGroupMessage');
  });

  it('returns true when receiveGroupMessage returns null (deduplication — not a failure)', async () => {
    // Dedup is intentional; the SDK already has this message. Still not a failure.
    _setNetworkForTesting(makeStubNetwork({
      receiveGroupMessage: async () => null,
    }));

    const result = await handleIncomingP2P(makeEnvelope({ type: 'group', groupId: 'g1' }));
    assert.equal(result, true,
      'deduplication is not a persistence-failure: receiveGroupMessage returning null must still yield true');
  });
});
