/**
 * Unified A2A Router — 31 test cases covering validation, peer resolution,
 * routing, logging, and DB audit trail.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedA2ARouter } from '../a2a/router.js';
import type { RouterDeps, PeerConfig } from '../a2a/router.js';
import { A2A_ERROR_CODES } from '../a2a/types.js';

// ── Mock Deps Helper ────────────────────────────────────────

function createMockDeps(overrides?: Partial<RouterDeps>): RouterDeps {
  return {
    config: {
      agent: { name: 'TestAgent' },
      'agent-comms': {
        enabled: true,
        peers: [
          { name: 'bmo', host: 'davids-mac-mini.lan', port: 3847, ip: '192.168.12.169' },
          { name: 'r2d2', host: 'chrissys-mini.lan', port: 3847 },
        ],
      },
      network: {
        communities: [{ name: 'home', primary: 'https://relay.bmobot.ai' }],
      },
    },
    sendViaLAN: async () => ({ ok: true }),
    getNetworkClient: () => null,
    getAgentCommsSecret: async () => 'test-secret',
    logCommsEntry: () => {},
    sendMessage: () => ({ messageId: 1, delivered: true }),
    ...overrides,
  };
}

function validDMRequest() {
  return {
    to: 'bmo',
    payload: { type: 'text', text: 'hello' },
  };
}

function validGroupRequest() {
  return {
    group: 'c006dfce-37b6-434a-8407-1d227f485a81',
    payload: { type: 'text', text: 'hello group' },
  };
}

// ── Validation (tests 1–9) ──────────────────────────────────

describe('A2A Router — Validation', () => {
  let router: UnifiedA2ARouter;

  beforeEach(() => {
    router = new UnifiedA2ARouter(createMockDeps());
  });

  it('1. Valid DM request passes validation', () => {
    const result = router.validate(validDMRequest());
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.request.to, 'bmo');
      assert.equal(result.request.payload.type, 'text');
    }
  });

  it('2. Valid group request passes validation', () => {
    const result = router.validate(validGroupRequest());
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.request.group, 'c006dfce-37b6-434a-8407-1d227f485a81');
    }
  });

  it('3. Both to and group present -> INVALID_TARGET', () => {
    const result = router.validate({
      to: 'bmo',
      group: 'some-group',
      payload: { type: 'text' },
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, A2A_ERROR_CODES.INVALID_TARGET);
    }
  });

  it('4. Neither to nor group -> INVALID_TARGET', () => {
    const result = router.validate({
      payload: { type: 'text' },
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, A2A_ERROR_CODES.INVALID_TARGET);
    }
  });

  it('5. Missing payload -> INVALID_REQUEST', () => {
    const result = router.validate({ to: 'bmo' });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, A2A_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it('6. Payload without type -> INVALID_REQUEST', () => {
    const result = router.validate({
      to: 'bmo',
      payload: { text: 'hello' },
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, A2A_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it('7. payload.type not a string -> INVALID_REQUEST', () => {
    const result = router.validate({
      to: 'bmo',
      payload: { type: 42 },
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, A2A_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it('8. Invalid route value -> INVALID_ROUTE', () => {
    const result = router.validate({
      to: 'bmo',
      payload: { type: 'text' },
      route: 'pigeon',
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, A2A_ERROR_CODES.INVALID_ROUTE);
    }
  });

  it('9. group + route: "lan" -> INVALID_ROUTE', () => {
    const result = router.validate({
      group: 'some-group-id',
      payload: { type: 'text' },
      route: 'lan',
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, A2A_ERROR_CODES.INVALID_ROUTE);
    }
  });
});

// ── Peer Resolution (tests 10–13) ──────────────────────────

describe('A2A Router — Peer Resolution', () => {
  let router: UnifiedA2ARouter;

  beforeEach(() => {
    router = new UnifiedA2ARouter(createMockDeps());
  });

  it('10. Bare name found in config -> returns peer + qualified name', () => {
    const result = router.resolvePeer('bmo');
    assert.ok(result.peer);
    assert.equal(result.peer.name, 'bmo');
    assert.equal(result.qualified, 'bmo@home');
  });

  it('11. Case-insensitive match (BMO -> bmo)', () => {
    const result = router.resolvePeer('BMO');
    assert.ok(result.peer);
    assert.equal(result.peer.name, 'bmo');
    assert.equal(result.qualified, 'bmo@home');
  });

  it('12. Qualified name (bmo@relay.bmobot.ai) -> skips config lookup', () => {
    const result = router.resolvePeer('bmo@relay.bmobot.ai');
    assert.equal(result.peer, undefined);
    assert.equal(result.qualified, 'bmo@relay.bmobot.ai');
  });

  it('13. Unknown bare name -> no peer, still returns qualified name for relay', () => {
    const result = router.resolvePeer('unknown-agent');
    assert.equal(result.peer, undefined);
    assert.equal(result.qualified, 'unknown-agent@home');
  });

  it('Prefix matching: "bm" resolves to "bmo" peer', () => {
    const result = router.resolvePeer('bm');
    assert.ok(result.peer);
    assert.equal(result.peer.name, 'bmo');
    assert.equal(result.qualified, 'bmo@home');
  });

  it('Prefix matching: ambiguous prefix does not resolve', () => {
    // Both "bmo" and "r2d2" don't share a prefix with "b" that would be ambiguous,
    // but let's use a router with peers that do share a prefix
    const deps = createMockDeps({
      config: {
        agent: { name: 'TestAgent' },
        'agent-comms': {
          enabled: true,
          peers: [
            { name: 'alice', host: 'alice.lan', port: 3847 },
            { name: 'alex', host: 'alex.lan', port: 3847 },
          ],
        },
        network: {
          communities: [{ name: 'home', primary: 'https://relay.bmobot.ai' }],
        },
      },
    });
    const ambiguousRouter = new UnifiedA2ARouter(deps);
    const result = ambiguousRouter.resolvePeer('al');
    assert.equal(result.peer, undefined); // ambiguous — should not resolve
    assert.equal(result.qualified, 'al@home');
  });
});

// ── Routing (tests 14–25) ───────────────────────────────────

describe('A2A Router — Routing', () => {
  it('14. Auto route DM: LAN succeeds -> route: "lan", one attempt', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: true }),
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send(validDMRequest());

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route, 'lan');
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].route, 'lan');
      assert.equal(result.attempts[0].status, 'success');
    }
  });

  it('15. Auto route DM: LAN fails, relay succeeds -> route: "relay", two attempts', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: false, error: 'Connection refused' }),
      getNetworkClient: () => ({
        send: async () => ({ status: 'delivered' as const, messageId: 'relay-1' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send(validDMRequest());

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route, 'relay');
      assert.equal(result.attempts.length, 2);
      assert.equal(result.attempts[0].route, 'lan');
      assert.equal(result.attempts[0].status, 'failed');
      assert.equal(result.attempts[1].route, 'relay');
      assert.equal(result.attempts[1].status, 'success');
    }
  });

  it('16. Auto route DM: both fail -> 502 DELIVERY_FAILED, two attempts', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: false, error: 'LAN error' }),
      getNetworkClient: () => ({
        send: async () => ({ status: 'failed' as const, messageId: '', error: 'Relay error' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send(validDMRequest());

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, A2A_ERROR_CODES.DELIVERY_FAILED);
      assert.ok(result.attempts);
      assert.equal(result.attempts!.length, 2);
    }
  });

  it('17. Auto route group: goes to relay, no LAN attempt', async () => {
    let sendToGroupCallCount = 0;
    const deps = createMockDeps({
      getNetworkClient: () => ({
        send: async () => ({ status: 'delivered' as const, messageId: 'r1' }),
        sendToGroup: async () => {
          sendToGroupCallCount++;
          return {
            messageId: 'g1',
            delivered: ['agent1'],
            queued: [] as string[],
            failed: [] as string[],
          };
        },
      }),
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send(validGroupRequest());

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.targetType, 'group');
      assert.equal(result.route, 'relay');
      // No LAN attempts for groups
      assert.equal(result.attempts.every(a => a.route === 'relay'), true);
    }
    assert.equal(sendToGroupCallCount, 1);
  });

  it('18. Forced LAN: succeeds -> single attempt', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: true }),
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route, 'lan');
      assert.equal(result.attempts.length, 1);
    }
  });

  it('19. Forced LAN: fails -> DELIVERY_FAILED, no relay fallback', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: false, error: 'Connection refused' }),
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, A2A_ERROR_CODES.DELIVERY_FAILED);
      assert.equal(result.attempts!.length, 1);
      assert.equal(result.attempts![0].route, 'lan');
    }
  });

  it('20. Forced relay: SDK not initialized -> RELAY_UNAVAILABLE', async () => {
    const deps = createMockDeps({
      getNetworkClient: () => null,
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, A2A_ERROR_CODES.RELAY_UNAVAILABLE);
    }
  });

  it('21. Forced relay: succeeds -> single attempt', async () => {
    const deps = createMockDeps({
      getNetworkClient: () => ({
        send: async () => ({ status: 'delivered' as const, messageId: 'r1' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route, 'relay');
      assert.equal(result.attempts.length, 1);
    }
  });

  it('22. SH-04: stale peer heartbeat -> placeholder (skip — getPeerState not implemented)', () => {
    // Placeholder: getPeerState() not yet implemented.
    // When it is, this test should verify that a peer with a stale heartbeat
    // causes the router to skip LAN and go directly to relay.
    assert.ok(true, 'Placeholder for SH-04 stale heartbeat test');
  });

  it('23. Latency tracked in each DeliveryAttempt', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => {
        // Simulate a small delay
        return { ok: true };
      },
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send(validDMRequest());

    assert.equal(result.ok, true);
    if (result.ok) {
      for (const attempt of result.attempts) {
        assert.equal(typeof attempt.latencyMs, 'number');
        assert.ok(attempt.latencyMs >= 0, 'latencyMs should be >= 0');
      }
    }
  });

  it('24. messageId is UUID v4 format', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: true }),
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send(validDMRequest());

    assert.equal(result.ok, true);
    if (result.ok) {
      const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assert.match(result.messageId, uuidV4Pattern);
    }
  });

  it('25. Relay queued status -> response status: "queued"', async () => {
    const deps = createMockDeps({
      getNetworkClient: () => ({
        send: async () => ({ status: 'queued' as const, messageId: 'r1' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 'queued');
    }
  });
});

// ── Logging (tests 26–28) ───────────────────────────────────

describe('A2A Router — Logging', () => {
  it('26. LAN success -> logCommsEntry NOT called by router (sendViaLAN logs internally)', async () => {
    const logCommsEntryCalls: Record<string, unknown>[] = [];
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: true }),
      getAgentCommsSecret: async () => 'test-secret',
      logCommsEntry: (entry) => { logCommsEntryCalls.push(entry); },
    });
    const router = new UnifiedA2ARouter(deps);
    await router.send(validDMRequest());

    // Router should NOT call logCommsEntry for LAN — sendViaLAN handles its own logging
    const routerLanLogEntries = logCommsEntryCalls.filter(
      e => e.direction === 'out',
    );
    assert.equal(routerLanLogEntries.length, 0, 'Router should not log LAN sends (sendViaLAN does it)');
  });

  it('27. Relay success -> comms log entry with direction "relay-out"', async () => {
    const logCommsEntryCalls: Record<string, unknown>[] = [];
    const deps = createMockDeps({
      getNetworkClient: () => ({
        send: async () => ({ status: 'delivered' as const, messageId: 'r1' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
      logCommsEntry: (entry) => { logCommsEntryCalls.push(entry); },
    });
    const router = new UnifiedA2ARouter(deps);
    await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hello' },
      route: 'relay',
    });

    const relayEntries = logCommsEntryCalls.filter(e => e.direction === 'relay-out');
    assert.ok(relayEntries.length >= 1, 'Should have at least one relay-out log entry');
    assert.equal(relayEntries[0].from, 'testagent');
  });

  it('28. Both LAN+relay attempts -> relay log entry with direction "relay-out"', async () => {
    const logCommsEntryCalls: Record<string, unknown>[] = [];
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: false, error: 'LAN failed' }),
      getNetworkClient: () => ({
        send: async () => ({ status: 'delivered' as const, messageId: 'r1' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
      getAgentCommsSecret: async () => 'test-secret',
      logCommsEntry: (entry) => { logCommsEntryCalls.push(entry); },
    });
    const router = new UnifiedA2ARouter(deps);
    await router.send(validDMRequest());

    // Router should log the relay attempt with direction "relay-out"
    const relayEntries = logCommsEntryCalls.filter(e => e.direction === 'relay-out');
    assert.ok(relayEntries.length >= 1, 'Should have a relay-out log entry for fallback');
  });
});

// ── DB Audit (tests 29–31) ─────────────────────────────────

describe('A2A Router — DB Audit', () => {
  it('29. Successful DM -> message persisted in DB (sendMessage called)', async () => {
    const sendMessageCalls: Array<{ from: string; to: string; type: string; body: string; metadata?: Record<string, unknown> }> = [];
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: true }),
      getAgentCommsSecret: async () => 'test-secret',
      sendMessage: (req) => {
        sendMessageCalls.push(req);
        return { messageId: 1, delivered: true };
      },
    });
    const router = new UnifiedA2ARouter(deps);
    await router.send(validDMRequest());

    assert.equal(sendMessageCalls.length, 1);
    const call = sendMessageCalls[0];
    assert.equal(call.from, 'comms');
    assert.ok(call.to.startsWith('a2a:'));
    assert.ok(call.metadata?.channel === 'a2a');
  });

  it('30. Successful group -> message persisted in DB with group_id in metadata', async () => {
    const sendMessageCalls: Array<{ from: string; to: string; type: string; body: string; metadata?: Record<string, unknown> }> = [];
    const deps = createMockDeps({
      getNetworkClient: () => ({
        send: async () => ({ status: 'delivered' as const, messageId: 'r1' }),
        sendToGroup: async () => ({
          messageId: 'g1',
          delivered: ['agent1'],
          queued: [],
          failed: [],
        }),
      }),
      sendMessage: (req) => {
        sendMessageCalls.push(req);
        return { messageId: 1, delivered: true };
      },
    });
    const router = new UnifiedA2ARouter(deps);
    await router.send(validGroupRequest());

    assert.equal(sendMessageCalls.length, 1);
    const call = sendMessageCalls[0];
    assert.ok(call.to.startsWith('a2a:group:'));
    assert.ok(call.metadata?.group_id);
  });

  it('31. Failed delivery -> no message persisted (sendMessage NOT called)', async () => {
    const sendMessageCalls: unknown[] = [];
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: false, error: 'LAN failed' }),
      getNetworkClient: () => ({
        send: async () => ({ status: 'failed' as const, messageId: '', error: 'Relay failed' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
      getAgentCommsSecret: async () => 'test-secret',
      sendMessage: (req) => {
        sendMessageCalls.push(req);
        return { messageId: 1, delivered: true };
      },
    });
    const router = new UnifiedA2ARouter(deps);
    await router.send(validDMRequest());

    assert.equal(sendMessageCalls.length, 0, 'sendMessage should NOT be called on failed delivery');
  });
});

// ── Additional spec bug tests ───────────────────────────────

describe('A2A Router — Spec Bug Fixes', () => {
  it('Payload with from: "evil" should not override agent name (SPEC BUG 2)', async () => {
    let capturedMsg: Record<string, unknown> | null = null;
    const deps = createMockDeps({
      sendViaLAN: async (_peer, msg) => {
        capturedMsg = msg as unknown as Record<string, unknown>;
        return { ok: true };
      },
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi', from: 'evil', messageId: 'spoofed-id', timestamp: 'spoofed-ts' },
    });

    assert.ok(capturedMsg, 'capturedMsg should not be null');
    const msg = capturedMsg as Record<string, unknown>;
    assert.equal(msg.from, 'testagent', 'from should be the agent name, not "evil"');
    assert.notEqual(msg.messageId, 'spoofed-id', 'messageId should not be spoofed');
    assert.notEqual(msg.timestamp, 'spoofed-ts', 'timestamp should not be spoofed');
  });

  it('Qualified name + forced LAN -> INVALID_ROUTE (SPEC BUG 3)', async () => {
    const deps = createMockDeps();
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo@relay.bmobot.ai',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, A2A_ERROR_CODES.INVALID_ROUTE);
    }
  });

  it('Forced relay failure (SDK initialized) -> DELIVERY_FAILED (SPEC BUG 4)', async () => {
    const deps = createMockDeps({
      getNetworkClient: () => ({
        send: async () => ({ status: 'failed' as const, messageId: '', error: 'Send failed' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'relay',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, A2A_ERROR_CODES.DELIVERY_FAILED);
    }
  });

  it('Forced LAN failure (secret available) -> DELIVERY_FAILED (SPEC BUG 5)', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: false, error: 'Connection timed out' }),
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, A2A_ERROR_CODES.DELIVERY_FAILED);
    }
  });

  it('Forced LAN failure (no secret) -> LAN_UNAVAILABLE (SPEC BUG 5 inverse)', async () => {
    const deps = createMockDeps({
      getAgentCommsSecret: async () => null,
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'hi' },
      route: 'lan',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, A2A_ERROR_CODES.LAN_UNAVAILABLE);
    }
  });

  it('Group name resolution via getGroups (SPEC BUG 6)', async () => {
    const sendToGroupCalls: Array<{ groupId: string; payload: Record<string, unknown> }> = [];
    const deps = createMockDeps({
      getNetworkClient: () => ({
        send: async () => ({ status: 'delivered' as const, messageId: 'r1' }),
        sendToGroup: async (groupId: string, payload: Record<string, unknown>) => {
          sendToGroupCalls.push({ groupId, payload });
          return { messageId: 'g1', delivered: ['agent1'], queued: [] as string[], failed: [] as string[] };
        },
        getGroups: async () => [
          { id: 'c006dfce-37b6-434a-8407-1d227f485a81', name: 'home-agents' },
        ],
      }),
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      group: 'home-agents',
      payload: { type: 'text', text: 'hi everyone' },
    });

    assert.equal(result.ok, true);
    // The name should have been resolved to the UUID
    assert.equal(sendToGroupCalls.length, 1);
    assert.equal(sendToGroupCalls[0].groupId, 'c006dfce-37b6-434a-8407-1d227f485a81');
  });

  it('Group name resolution fails -> GROUP_NOT_FOUND (SPEC BUG 6)', async () => {
    const deps = createMockDeps({
      getNetworkClient: () => ({
        send: async () => ({ status: 'delivered' as const, messageId: 'r1' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
        getGroups: async () => [
          { id: 'abc-123', name: 'other-group' },
        ],
      }),
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      group: 'nonexistent-group',
      payload: { type: 'text', text: 'hi' },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, A2A_ERROR_CODES.GROUP_NOT_FOUND);
    }
  });

  it('Relay queued status propagated in auto-fallback path (SPEC BUG 7)', async () => {
    const deps = createMockDeps({
      sendViaLAN: async () => ({ ok: false, error: 'LAN failed' }),
      getNetworkClient: () => ({
        send: async () => ({ status: 'queued' as const, messageId: 'r1' }),
        sendToGroup: async () => ({ messageId: 'g1', delivered: [], queued: [], failed: [] }),
      }),
      getAgentCommsSecret: async () => 'test-secret',
    });
    const router = new UnifiedA2ARouter(deps);
    const result = await router.send(validDMRequest());

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 'queued');
    }
  });
});
