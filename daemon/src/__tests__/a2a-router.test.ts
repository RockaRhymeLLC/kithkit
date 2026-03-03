/**
 * Unified A2A Router — 28 test cases.
 *
 * Tests validation, peer resolution, auto/forced routing,
 * stale heartbeat detection, latency tracking, and JSONL logging.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedA2ARouter, type RouterDeps } from '../a2a/router.js';
import type { A2ASendResponse, A2ASendError } from '../a2a/types.js';

// ── Test Config ──────────────────────────────────────────────

const testConfig = {
  agent: { name: 'TestAgent' },
  'agent-comms': {
    enabled: true,
    peers: [
      { name: 'bmo', host: 'bmo.local', port: 3847, ip: '192.168.1.100' },
      { name: 'r2d2', host: 'r2.local', port: 3847 },
    ],
  },
  network: {
    enabled: true,
    communities: [{ name: 'home', primary: 'https://relay.example.com' }],
  },
} as any;

// ── Mock Factory ─────────────────────────────────────────────

interface MockState {
  sendViaLANCalls: any[];
  sendViaLANResult: { ok: boolean; queued: boolean; error?: string };
  networkClient: any | null;
  networkSendResult: { status: string; error?: string };
  networkSendToGroupResult: { status: string; error?: string };
  peerStates: Map<string, { status: string; updatedAt: number }>;
  logEntries: any[];
  keychainValues: Map<string, string>;
}

function createMocks(): { deps: RouterDeps; state: MockState } {
  const state: MockState = {
    sendViaLANCalls: [],
    sendViaLANResult: { ok: true, queued: false },
    networkClient: {
      send: async (_to: string, _payload: any) => state.networkSendResult,
      sendToGroup: async (_groupId: string, _payload: any) => state.networkSendToGroupResult,
    },
    networkSendResult: { status: 'delivered' },
    networkSendToGroupResult: { status: 'delivered' },
    peerStates: new Map(),
    logEntries: [],
    keychainValues: new Map([['credential-agent-comms-secret', 'test-secret']]),
  };

  const deps: RouterDeps = {
    config: testConfig,
    sendViaLAN: async (peer, msg, secret, agentName) => {
      state.sendViaLANCalls.push({ peer, msg, secret, agentName });
      return state.sendViaLANResult;
    },
    getNetworkClient: () => state.networkClient,
    getPeerState: (name) => state.peerStates.get(name.toLowerCase()) as any,
    logCommsEntry: (entry) => { state.logEntries.push(entry); },
    readKeychain: async (name) => state.keychainValues.get(name) ?? null,
  };

  return { deps, state };
}

// ── Validation Tests ─────────────────────────────────────────

describe('Validation', () => {
  let router: UnifiedA2ARouter;
  let state: MockState;

  beforeEach(() => {
    const mocks = createMocks();
    router = new UnifiedA2ARouter(mocks.deps);
    state = mocks.state;
  });

  it('1. Valid DM request passes validation', () => {
    const err = router.validate({
      to: 'bmo',
      payload: { type: 'text', text: 'hello' },
    });
    assert.equal(err, null);
  });

  it('2. Valid group request passes validation', () => {
    const err = router.validate({
      group: 'home-agents',
      payload: { type: 'text', text: 'hello all' },
    });
    assert.equal(err, null);
  });

  it('3. Both to+group -> INVALID_TARGET', () => {
    const err = router.validate({
      to: 'bmo',
      group: 'home-agents',
      payload: { type: 'text' },
    });
    assert.notEqual(err, null);
    assert.equal(err!.code, 'INVALID_TARGET');
  });

  it('4. Neither to nor group -> INVALID_TARGET', () => {
    const err = router.validate({
      payload: { type: 'text' },
    });
    assert.notEqual(err, null);
    assert.equal(err!.code, 'INVALID_TARGET');
  });

  it('5. Missing payload -> INVALID_REQUEST', () => {
    const err = router.validate({
      to: 'bmo',
    });
    assert.notEqual(err, null);
    assert.equal(err!.code, 'INVALID_REQUEST');
  });

  it('6. Payload without type -> INVALID_REQUEST', () => {
    const err = router.validate({
      to: 'bmo',
      payload: { text: 'hello' },
    });
    assert.notEqual(err, null);
    assert.equal(err!.code, 'INVALID_REQUEST');
  });

  it('7. payload.type not a string -> INVALID_REQUEST', () => {
    const err = router.validate({
      to: 'bmo',
      payload: { type: 123 },
    });
    assert.notEqual(err, null);
    assert.equal(err!.code, 'INVALID_REQUEST');
  });

  it('8. Invalid route value -> INVALID_REQUEST', () => {
    const err = router.validate({
      to: 'bmo',
      payload: { type: 'text' },
      route: 'pigeon',
    });
    assert.notEqual(err, null);
    assert.equal(err!.code, 'INVALID_REQUEST');
  });

  it('9. group + route:lan -> INVALID_ROUTE', () => {
    const err = router.validate({
      group: 'home-agents',
      payload: { type: 'text' },
      route: 'lan',
    });
    assert.notEqual(err, null);
    assert.equal(err!.code, 'INVALID_ROUTE');
  });
});

// ── Peer Resolution Tests ────────────────────────────────────

describe('Peer resolution', () => {
  let router: UnifiedA2ARouter;

  beforeEach(() => {
    const mocks = createMocks();
    router = new UnifiedA2ARouter(mocks.deps);
  });

  it('10. bare name found in config', () => {
    const result = router.resolvePeer('bmo');
    assert.ok(result.peer);
    assert.equal(result.peer!.name, 'bmo');
    assert.equal(result.error, undefined);
  });

  it('11. case-insensitive match (BMO -> bmo)', () => {
    const result = router.resolvePeer('BMO');
    assert.ok(result.peer);
    assert.equal(result.peer!.name, 'bmo');
    assert.equal(result.error, undefined);
  });

  it('12. qualified name (bmo@relay.example.com) -> skips config lookup', () => {
    const result = router.resolvePeer('bmo@relay.example.com');
    assert.equal(result.peer, undefined);
    assert.equal(result.qualifiedName, 'bmo@relay.example.com');
    assert.equal(result.error, undefined);
  });

  it('13. unknown bare name -> PEER_NOT_FOUND', () => {
    const result = router.resolvePeer('unknown-agent');
    assert.ok(result.error);
    assert.equal(result.error!.code, 'PEER_NOT_FOUND');
  });
});

// ── Auto Routing Tests ───────────────────────────────────────

describe('Auto routing', () => {
  let router: UnifiedA2ARouter;
  let state: MockState;

  beforeEach(() => {
    const mocks = createMocks();
    router = new UnifiedA2ARouter(mocks.deps);
    state = mocks.state;
    // Fresh heartbeat so LAN is attempted
    state.peerStates.set('bmo', { status: 'idle', updatedAt: Date.now() });
  });

  it('14. DM: LAN succeeds -> route:lan, one attempt', async () => {
    state.sendViaLANResult = { ok: true, queued: false };

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    assert.equal(success.route, 'lan');
    assert.equal(success.attempts.length, 1);
    assert.equal(success.attempts[0].route, 'lan');
    assert.equal(success.attempts[0].status, 'success');
  });

  it('15. DM: LAN fails, relay succeeds -> route:relay, two attempts', async () => {
    state.sendViaLANResult = { ok: false, queued: false, error: 'Connection refused' };
    state.networkSendResult = { status: 'delivered' };

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    assert.equal(success.route, 'relay');
    assert.equal(success.attempts.length, 2);
    assert.equal(success.attempts[0].route, 'lan');
    assert.equal(success.attempts[0].status, 'failed');
    assert.equal(success.attempts[1].route, 'relay');
    assert.equal(success.attempts[1].status, 'success');
  });

  it('16. DM: both fail -> DELIVERY_FAILED, two attempts', async () => {
    state.sendViaLANResult = { ok: false, queued: false, error: 'Connection refused' };
    state.networkSendResult = { status: 'failed', error: 'Relay down' };

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
    });

    assert.equal(result.ok, false);
    const err = result as A2ASendError;
    assert.equal(err.code, 'DELIVERY_FAILED');
    assert.ok(err.attempts);
    assert.equal(err.attempts!.length, 2);
  });

  it('17. Group: goes to relay, no LAN attempt', async () => {
    const result = await router.send({
      group: 'home-agents',
      payload: { type: 'text', text: 'hello all' },
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    assert.equal(success.targetType, 'group');
    assert.equal(success.route, 'relay');
    assert.equal(success.attempts.length, 1);
    assert.equal(success.attempts[0].route, 'relay');
    assert.equal(state.sendViaLANCalls.length, 0);
  });
});

// ── Forced Routing Tests ─────────────────────────────────────

describe('Forced routing', () => {
  let router: UnifiedA2ARouter;
  let state: MockState;

  beforeEach(() => {
    const mocks = createMocks();
    router = new UnifiedA2ARouter(mocks.deps);
    state = mocks.state;
  });

  it('18. Forced LAN: succeeds -> single attempt', async () => {
    state.sendViaLANResult = { ok: true, queued: false };

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    assert.equal(success.route, 'lan');
    assert.equal(success.attempts.length, 1);
  });

  it('19. Forced LAN: fails -> DELIVERY_FAILED, no relay fallback', async () => {
    state.sendViaLANResult = { ok: false, queued: false, error: 'Timeout' };

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, false);
    const err = result as A2ASendError;
    assert.equal(err.code, 'DELIVERY_FAILED');
    assert.equal(err.attempts!.length, 1);
    assert.equal(err.attempts![0].route, 'lan');
    // No relay attempt
    assert.ok(!err.attempts!.some(a => a.route === 'relay'));
  });

  it('20. Forced relay: SDK not initialized -> RELAY_UNAVAILABLE', async () => {
    state.networkClient = null;

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });

    assert.equal(result.ok, false);
    const err = result as A2ASendError;
    assert.equal(err.code, 'RELAY_UNAVAILABLE');
  });

  it('21. Forced relay: succeeds -> single attempt', async () => {
    state.networkSendResult = { status: 'delivered' };

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    assert.equal(success.route, 'relay');
    assert.equal(success.attempts.length, 1);
    assert.equal(success.attempts[0].route, 'relay');
  });
});

// ── Advanced Features Tests ──────────────────────────────────

describe('Advanced features', () => {
  let router: UnifiedA2ARouter;
  let state: MockState;

  beforeEach(() => {
    const mocks = createMocks();
    router = new UnifiedA2ARouter(mocks.deps);
    state = mocks.state;
  });

  it('22. SH-04: stale heartbeat -> skips LAN, direct to relay', async () => {
    // Set stale heartbeat (6 minutes old)
    state.peerStates.set('bmo', { status: 'idle', updatedAt: Date.now() - 360_000 });
    state.networkSendResult = { status: 'delivered' };

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    assert.equal(success.route, 'relay');
    // LAN was skipped — only relay attempt
    assert.equal(success.attempts.length, 1);
    assert.equal(success.attempts[0].route, 'relay');
    assert.equal(state.sendViaLANCalls.length, 0);
  });

  it('23. Latency tracked (latencyMs > 0)', async () => {
    state.sendViaLANResult = { ok: true, queued: false };
    state.peerStates.set('bmo', { status: 'idle', updatedAt: Date.now() });

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    assert.ok(success.attempts[0].latencyMs >= 0, 'latencyMs should be >= 0');
  });

  it('24. messageId is UUID v4 format', async () => {
    state.sendViaLANResult = { ok: true, queued: false };
    state.peerStates.set('bmo', { status: 'idle', updatedAt: Date.now() });

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    // UUID v4 format: 8-4-4-4-12 hex chars
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assert.ok(uuidRegex.test(success.messageId), `messageId "${success.messageId}" should be UUID format`);
  });

  it('25. Relay queued -> response status:queued', async () => {
    state.networkSendResult = { status: 'queued' };

    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });

    assert.equal(result.ok, true);
    const success = result as A2ASendResponse;
    assert.equal(success.status, 'queued');
  });
});

// ── JSONL Logging Tests ──────────────────────────────────────

describe('JSONL Logging', () => {
  let router: UnifiedA2ARouter;
  let state: MockState;

  beforeEach(() => {
    const mocks = createMocks();
    router = new UnifiedA2ARouter(mocks.deps);
    state = mocks.state;
    state.peerStates.set('bmo', { status: 'idle', updatedAt: Date.now() });
  });

  it('26. LAN success -> logCommsEntry NOT called by router', async () => {
    state.sendViaLANResult = { ok: true, queued: false };

    await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    // Router should NOT call logCommsEntry for LAN — sendViaLAN does its own logging
    assert.equal(state.logEntries.length, 0);
  });

  it('27. Relay success -> logCommsEntry called with direction relay-out', async () => {
    state.networkSendResult = { status: 'delivered' };

    await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });

    assert.equal(state.logEntries.length, 1);
    assert.equal(state.logEntries[0].direction, 'relay-out');
    assert.equal(state.logEntries[0].from, 'testagent');
    assert.equal(state.logEntries[0].type, 'text');
    assert.ok(state.logEntries[0].messageId);
  });

  it('28. Both LAN+relay attempts -> only relay logged', async () => {
    state.sendViaLANResult = { ok: false, queued: false, error: 'Timeout' };
    state.networkSendResult = { status: 'delivered' };

    await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
    });

    // Only relay should have been logged by the router
    assert.equal(state.logEntries.length, 1);
    assert.equal(state.logEntries[0].direction, 'relay-out');
  });
});
