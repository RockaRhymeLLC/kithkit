/**
 * Bar 1 — msg.verified inject gate for wireMessageEvent / wireGroupMessageEvent (todo #3058).
 *
 * Design:
 *   The SDK's processEnvelope (messaging.ts) THROWS on a bad Ed25519 signature, so the
 *   'message'/'group-message' event never fires for bad-sig envelopes in production.
 *   The gate added in wireMessageEvent/wireGroupMessageEvent is defence-in-depth for any
 *   future SDK path that returns msg.verified=false instead of throwing.
 *
 *   These tests drive the GATE LOGIC directly — the stub network emits msg.verified=false
 *   (within the Message type contract) and we assert the gate's posture-based decision.
 *   No injectable 'verified' seam exists in sdk-bridge.ts code; the check runs on the
 *   real msg.verified field from the event.
 *
 * Non-vacuity proof:
 *   If the enforce gate (`if (!msg.verified && posture === 'enforce') return;`) is removed
 *   from wireMessageEvent/wireGroupMessageEvent, the enforce tests below go RED:
 *   _injectFn IS called (inject happens) when the test asserts injectCalls.length === 0.
 *   Paste the RED output in the PR description per the R2 bar requirement.
 *
 * Bar 2 ruling (see PR description): msg.verified is computed entirely from the locally-cached
 * sender public key (getCachedContact → processEnvelope). No per-peer key fetch occurs during
 * verification, so key-refresh-on-miss / refetch-amplification-DoS is out of scope for this PR.
 * That work belongs to TOFU todo 3069.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  _resetForTesting,
  _wireEventsForTesting,
  _setSendMessageForTesting,
} from '../sdk-bridge.js';
import type { A2ANetworkClient, Message, GroupMessage } from '../sdk-types.js';
import type { AgentConfig } from '../../../config.js';

// ── Helpers ───────────────────────────────────────────────────

function makeConfig(p2p: 'enforce' | 'permissive'): AgentConfig {
  return { a2a: { security: { p2p } } } as unknown as AgentConfig;
}

/**
 * Minimal EventEmitter-based network stub that exposes typed emit helpers.
 * Satisfies the A2ANetworkClient `on` contract; other methods are irrelevant here.
 */
class StubNetwork extends EventEmitter {
  emitDM(overrides: Partial<Message> = {}): void {
    const msg: Message = {
      sender: 'peer',
      messageId: 'test-dm-1',
      timestamp: new Date().toISOString(),
      payload: { type: 'text', text: 'hello' },
      verified: true,
      ...overrides,
    };
    this.emit('message', msg);
  }

  emitGroup(overrides: Partial<GroupMessage> = {}): void {
    const msg: GroupMessage = {
      sender: 'peer',
      messageId: 'test-gm-1',
      groupId: 'group-aabbccdd',
      timestamp: new Date().toISOString(),
      payload: { type: 'text', text: 'hi group' },
      verified: true,
      ...overrides,
    };
    this.emit('group-message', msg);
  }
}

// ── DM gate tests ─────────────────────────────────────────────

describe('wireMessageEvent inject gate — DM (Bar 1: todo #3058)', () => {
  let injectCalls: unknown[];

  beforeEach(() => {
    _resetForTesting();
    injectCalls = [];
    _setSendMessageForTesting((opts) => { injectCalls.push(opts); return { messageId: 0, delivered: false }; });
  });

  afterEach(() => {
    _resetForTesting();
  });

  it('enforce posture: verified=false is NOT injected (fail-closed)', () => {
    const stub = new StubNetwork();
    _wireEventsForTesting(stub as unknown as A2ANetworkClient, makeConfig('enforce'));

    stub.emitDM({ verified: false });

    assert.strictEqual(
      injectCalls.length,
      0,
      'Unverified DM must NOT be injected under enforce posture. ' +
      'If RED: the enforce gate (if !msg.verified && enforce) is absent from wireMessageEvent — add it.',
    );
  });

  it('permissive posture: verified=false IS injected (warn, no behaviour change from today)', () => {
    const stub = new StubNetwork();
    _wireEventsForTesting(stub as unknown as A2ANetworkClient, makeConfig('permissive'));

    stub.emitDM({ verified: false });

    assert.strictEqual(
      injectCalls.length,
      1,
      'Unverified DM must still be injected under permissive posture. ' +
      'DISTINCT from enforce (above) — proves non-vacuity: outcomes differ.',
    );
  });

  it('enforce posture: verified=true IS injected (happy path)', () => {
    const stub = new StubNetwork();
    _wireEventsForTesting(stub as unknown as A2ANetworkClient, makeConfig('enforce'));

    stub.emitDM({ verified: true });

    assert.strictEqual(
      injectCalls.length,
      1,
      'Verified DM must be injected regardless of posture.',
    );
  });

  it('enforce vs permissive: distinct outcomes for verified=false (mutation-kill discriminator)', () => {
    // enforce
    const stubE = new StubNetwork();
    const enforceInjections: unknown[] = [];
    _setSendMessageForTesting((opts) => { enforceInjections.push(opts); return { messageId: 0, delivered: false }; });
    _wireEventsForTesting(stubE as unknown as A2ANetworkClient, makeConfig('enforce'));
    stubE.emitDM({ verified: false });

    // permissive
    _resetForTesting();
    const permissiveInjections: unknown[] = [];
    _setSendMessageForTesting((opts) => { permissiveInjections.push(opts); return { messageId: 0, delivered: false }; });
    const stubP = new StubNetwork();
    _wireEventsForTesting(stubP as unknown as A2ANetworkClient, makeConfig('permissive'));
    stubP.emitDM({ verified: false });

    assert.strictEqual(enforceInjections.length, 0, 'enforce: no inject for verified=false');
    assert.strictEqual(permissiveInjections.length, 1, 'permissive: inject for verified=false');
    assert.notStrictEqual(
      enforceInjections.length,
      permissiveInjections.length,
      'Outcomes MUST differ — identical counts indicate vacuous gate.',
    );
  });
});

// ── Group gate tests ──────────────────────────────────────────

describe('wireGroupMessageEvent inject gate — group (Bar 1: todo #3058)', () => {
  let injectCalls: unknown[];

  beforeEach(() => {
    _resetForTesting();
    injectCalls = [];
    _setSendMessageForTesting((opts) => { injectCalls.push(opts); return { messageId: 0, delivered: false }; });
  });

  afterEach(() => {
    _resetForTesting();
  });

  it('enforce posture: verified=false group message is NOT injected (fail-closed)', () => {
    const stub = new StubNetwork();
    _wireEventsForTesting(stub as unknown as A2ANetworkClient, makeConfig('enforce'));

    stub.emitGroup({ verified: false });

    assert.strictEqual(
      injectCalls.length,
      0,
      'Unverified group message must NOT be injected under enforce posture. ' +
      'If RED: enforce gate is absent from wireGroupMessageEvent.',
    );
  });

  it('permissive posture: verified=false group message IS injected (warn, no change)', () => {
    const stub = new StubNetwork();
    _wireEventsForTesting(stub as unknown as A2ANetworkClient, makeConfig('permissive'));

    stub.emitGroup({ verified: false });

    assert.strictEqual(
      injectCalls.length,
      1,
      'Unverified group message must be injected under permissive posture.',
    );
  });

  it('enforce posture: verified=true group message IS injected', () => {
    const stub = new StubNetwork();
    _wireEventsForTesting(stub as unknown as A2ANetworkClient, makeConfig('enforce'));

    stub.emitGroup({ verified: true });

    assert.strictEqual(injectCalls.length, 1, 'Verified group message must be injected.');
  });

  it('enforce vs permissive: distinct outcomes for group verified=false', () => {
    // enforce
    const stubE = new StubNetwork();
    const enforceInjections: unknown[] = [];
    _setSendMessageForTesting((opts) => { enforceInjections.push(opts); return { messageId: 0, delivered: false }; });
    _wireEventsForTesting(stubE as unknown as A2ANetworkClient, makeConfig('enforce'));
    stubE.emitGroup({ verified: false });

    // permissive
    _resetForTesting();
    const permissiveInjections: unknown[] = [];
    _setSendMessageForTesting((opts) => { permissiveInjections.push(opts); return { messageId: 0, delivered: false }; });
    const stubP = new StubNetwork();
    _wireEventsForTesting(stubP as unknown as A2ANetworkClient, makeConfig('permissive'));
    stubP.emitGroup({ verified: false });

    assert.strictEqual(enforceInjections.length, 0, 'enforce: no inject for unverified group msg');
    assert.strictEqual(permissiveInjections.length, 1, 'permissive: inject for unverified group msg');
    assert.notStrictEqual(
      enforceInjections.length,
      permissiveInjections.length,
      'Distinct outcomes required — identical counts = vacuous gate.',
    );
  });
});
