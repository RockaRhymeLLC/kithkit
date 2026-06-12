/**
 * t-310: isMdnsHost correctly classifies hostnames
 * t-311: relay probe attempted before peer is marked down on .lan/.local failure
 * t-312: peer NOT marked down / failed NOT incremented when relay probe succeeds
 * t-313: peer marked unreachable when both .lan DNS and relay fail
 * t-314: updatePeerState exported from agent-comms + called on successful heartbeat (Fix 1 mutation-kill)
 * t-315: relay-fallback removal causes t-312 / t-313 assertions to fail (Fix 2 mutation-kill — see report)
 * t-316: quiet-period guard — both pings fail + no recent traffic → NO dispatch (kithkit#77 fix)
 *        mutation-kill: removing the guard re-introduces the false-positive dispatch and t-316 goes RED.
 * t-317: live-ping gate (todo #854 fast-follow) — peer responds to live ping despite broken delivery
 *        channel → NO recovery dispatch; revert live-ping gate → dispatch happens → t-317 goes RED.
 * t-318: count-semantics (todo #854 fast-follow) — inbound==0 is the sole quiet-period discriminator;
 *        inject alone does NOT trigger dispatch; revert to (inbound===0 && inject===0) → t-318 goes RED.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMdnsHost,
  _setCommsForTesting,
  _setFetchForTesting,
  _setLoadConfigForTesting,
  _setScanForPeersForTesting,
  _setGetMessageCountsForTesting,
  _setLivePingForTesting,
  _resetForTesting,
  _runForTesting,
} from '../automation/tasks/peer-heartbeat.js';

import {
  updatePeerState,
  getPeerState,
  stopAgentComms,
} from '../extensions/comms/agent-comms.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

import type { KithkitConfig } from '../core/config.js';

function makeLanConfig(relayPort = 3847): KithkitConfig {
  return {
    agent: { name: 'test-agent' },
    daemon: { port: relayPort, log_level: 'info', log_dir: 'logs', log_rotation: { max_size_mb: 10, max_files: 5 } },
    'agent-comms': {
      enabled: true,
      peers: [
        { name: 'bmo', host: 'agent-b.lan', port: 3847 },
      ],
    },
    scheduler: { tasks: [] },
    security: { rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 } },
    network: {},
  } as unknown as KithkitConfig;
}

function makeNonMdnsConfig(): KithkitConfig {
  return {
    agent: { name: 'test-agent' },
    daemon: { port: 3847, log_level: 'info', log_dir: 'logs', log_rotation: { max_size_mb: 10, max_files: 5 } },
    'agent-comms': {
      enabled: true,
      peers: [
        { name: 'bmo', host: '192.0.2.50', port: 3847 },
      ],
    },
    scheduler: { tasks: [] },
    security: { rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 } },
    network: {},
  } as unknown as KithkitConfig;
}

/** Creates a mock fetch that returns the given relay response. */
function makeFetchMock(relayOk: boolean): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    calls.push(typeof url === 'string' ? url : url.toString());
    const body = JSON.stringify({ ok: relayOk });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

/** Creates a mock comms object with spy functions. */
function makeCommsMock(sendOk: boolean) {
  const updatePeerStateCalls: Array<{ name: string; state: { status: string; updatedAt: number } }> = [];
  const setPeerIpOverrideCalls: Array<{ name: string; ip: string }> = [];

  return {
    updatePeerState: (peerName: string, state: { status: string; updatedAt: number }) => {
      updatePeerStateCalls.push({ name: peerName, state });
    },
    setPeerIpOverride: (peerName: string, ip: string) => {
      setPeerIpOverrideCalls.push({ name: peerName, ip });
    },
    sendAgentMessage: async (_name: string, _type: string, _text: unknown, _extra: unknown) => {
      return { ok: sendOk, queued: false };
    },
    _calls: { updatePeerState: updatePeerStateCalls, setPeerIpOverride: setPeerIpOverrideCalls },
  };
}

// ── t-310: isMdnsHost ─────────────────────────────────────────────────────────

describe('t-310: isMdnsHost classifies hostnames', () => {
  it('returns true for .lan hostnames', () => {
    assert.equal(isMdnsHost('agent-b.lan'), true);
    assert.equal(isMdnsHost('peer.lan'), true);
    assert.equal(isMdnsHost('device.something.lan'), true);
  });

  it('returns true for .local hostnames', () => {
    assert.equal(isMdnsHost('macbook.local'), true);
    assert.equal(isMdnsHost('server.local'), true);
  });

  it('returns false for IP addresses', () => {
    assert.equal(isMdnsHost('192.0.2.1'), false);
    assert.equal(isMdnsHost('10.0.0.50'), false);
  });

  it('returns false for regular domain names', () => {
    assert.equal(isMdnsHost('peer.example.com'), false);
    assert.equal(isMdnsHost('relay.example.com'), false);
    assert.equal(isMdnsHost('localhost'), false);
  });
});

// ── t-311: relay probe attempted before marking .lan peer down ───────────────

describe('t-311: relay probe attempted before peer is marked down on mDNS failure', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('calls the relay endpoint when .lan send fails', async () => {
    const fetchMock = makeFetchMock(false); // relay also fails
    const commsMock = makeCommsMock(false); // direct send fails

    _setLoadConfigForTesting(() => makeLanConfig(9999));
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());

    await _runForTesting();

    // At least one fetch call to the relay endpoint must have been made
    assert.ok(fetchMock.calls.length > 0, 'probeViaRelay must have called fetch');
    assert.ok(
      fetchMock.calls.some((u) => u.includes('/api/a2a/send')),
      `Expected /api/a2a/send in fetch calls, got: ${JSON.stringify(fetchMock.calls)}`,
    );
  });

  it('does NOT immediately call updatePeerState before attempting the relay probe', async () => {
    // Track the order of calls: fetch must come before any updatePeerState('unknown'/'unreachable')
    const order: string[] = [];
    const comms = {
      sendAgentMessage: async () => ({ ok: false, queued: false }),
      updatePeerState: (name: string, state: { status: string }) => {
        order.push(`updatePeerState:${state.status}`);
      },
      setPeerIpOverride: () => {},
    };
    const fetchFn: typeof fetch = async () => {
      order.push('fetch:relay');
      return new Response(JSON.stringify({ ok: false }), { status: 200 });
    };

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(comms);
    _setFetchForTesting(fetchFn);
    _setScanForPeersForTesting(async () => new Map());

    await _runForTesting();

    const relayIdx = order.indexOf('fetch:relay');
    const downIdx = order.findIndex((e) => e.startsWith('updatePeerState:unreachable') || e.startsWith('updatePeerState:unknown'));
    assert.ok(relayIdx >= 0, 'fetch:relay must appear in order log');
    assert.ok(downIdx >= 0, 'updatePeerState:unreachable must appear in order log');
    assert.ok(relayIdx < downIdx, `relay probe (idx ${relayIdx}) must precede updatePeerState:down (idx ${downIdx})`);
  });
});

// ── t-312: peer NOT marked down when relay succeeds ───────────────────────────

describe('t-312: peer not marked down/unknown when relay probe succeeds (false-down guard)', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('does not call updatePeerState with unknown/unreachable when relay succeeds', async () => {
    const fetchMock = makeFetchMock(true); // relay succeeds
    const commsMock = makeCommsMock(false); // direct .lan send fails

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());

    await _runForTesting();

    const badStatuses = commsMock._calls.updatePeerState.filter(
      (c) => c.state.status === 'unknown' || c.state.status === 'unreachable',
    );
    assert.equal(
      badStatuses.length,
      0,
      `updatePeerState must NOT be called with unknown/unreachable when relay succeeds. Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
  });

  it('calls updatePeerState with local-dns-indeterminate when relay succeeds', async () => {
    const fetchMock = makeFetchMock(true);
    const commsMock = makeCommsMock(false);

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());

    await _runForTesting();

    const indeterminate = commsMock._calls.updatePeerState.find(
      (c) => c.state.status === 'local-dns-indeterminate',
    );
    assert.ok(
      indeterminate !== undefined,
      `updatePeerState must be called with local-dns-indeterminate. Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
    assert.equal(indeterminate!.name, 'bmo');
  });

  it('does not invoke the relay probe for non-mDNS peers', async () => {
    const fetchMock = makeFetchMock(true);
    const commsMock = makeCommsMock(false);

    _setLoadConfigForTesting(() => makeNonMdnsConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());

    await _runForTesting();

    // No relay call for non-mDNS host
    assert.equal(fetchMock.calls.length, 0, 'relay probe must NOT be called for non-mDNS peers');
    // Should be marked unknown (original behaviour)
    const unknownCall = commsMock._calls.updatePeerState.find((c) => c.state.status === 'unknown');
    assert.ok(unknownCall !== undefined, 'non-mDNS failed peer must be marked unknown');
  });
});

// ── t-313: peer marked unreachable when both probes fail ─────────────────────

describe('t-313: peer marked unreachable when .lan DNS and relay both fail', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('calls updatePeerState with unreachable when relay probe also fails', async () => {
    const fetchMock = makeFetchMock(false); // relay fails
    const commsMock = makeCommsMock(false); // direct fails

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());

    await _runForTesting();

    const unreachableCall = commsMock._calls.updatePeerState.find(
      (c) => c.state.status === 'unreachable',
    );
    assert.ok(
      unreachableCall !== undefined,
      `updatePeerState must be called with unreachable when both probes fail. Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
    assert.equal(unreachableCall!.name, 'bmo');
  });
});

// ── t-314: updatePeerState exported from agent-comms (Fix 1 mutation-kill) ───

describe('t-314: updatePeerState is exported from agent-comms and functional (Fix 1 mutation-kill)', () => {
  afterEach(() => { stopAgentComms(); });

  it('updatePeerState is a function (not undefined — would no-op via optional chaining if missing)', () => {
    assert.equal(typeof updatePeerState, 'function',
      'updatePeerState must be exported from agent-comms; if missing, all comms.updatePeerState?.() calls silently no-op');
  });

  it('getPeerState returns the state set by updatePeerState', () => {
    updatePeerState('bmo', { status: 'idle', updatedAt: 12345 });
    const state = getPeerState('bmo');
    assert.ok(state !== undefined, 'getPeerState must return the state set by updatePeerState');
    assert.equal(state!.status, 'idle');
    assert.equal(state!.updatedAt, 12345);
  });

  it('updatePeerState is invoked by the heartbeat when send succeeds (real comms module, not a spy)', async () => {
    // Use the REAL agent-comms module as the injectable.
    // If updatePeerState were not exported, comms.updatePeerState?.() would silently
    // no-op and getPeerState would return undefined, failing the assertion below.
    stopAgentComms(); // clear any prior state

    const realComms = await import('../extensions/comms/agent-comms.js');
    const realCommsSendOverride = {
      ...realComms,
      // Override sendAgentMessage to return ok:true without hitting the network
      sendAgentMessage: async () => ({ ok: true, queued: false }),
    };

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(realCommsSendOverride);
    _setScanForPeersForTesting(async () => new Map());

    await _runForTesting();

    // The real updatePeerState must have been called — getPeerState proves it
    const state = realComms.getPeerState('bmo');
    assert.ok(state !== undefined,
      'getPeerState must return a state after heartbeat success. ' +
      'If this fails, updatePeerState was not called (likely not exported).');
    assert.equal(state!.status, 'idle',
      'Peer state after successful heartbeat must be idle');

    _resetForTesting();
  });
});

// ── t-316: quiet-period guard (kithkit#77 fix) ────────────────────────────────
//
// Root cause: when both the direct-LAN ping (sendAgentMessage) and the relay
// probe fail, the watchdog dispatched recovery unconditionally — triggering
// false-positive updatePeerState('unreachable') + ARP scans during quiet
// periods where the peer is intentionally offline.
//
// Fix: before dispatching recovery, cross-check inbound-webhook-count (messages
// received FROM the peer in the last 10 min) vs inject-count (of those, the
// ones confirmed injected).  Both zero → quiet period → NO dispatch.
//
// Mutation-kill: reverting the guard (removing the getMessageCounts() check and
// always dispatching recovery when both probes fail) causes sub-test (a) to
// observe an unexpected updatePeerState call, failing the assertion.

describe('t-316: quiet-period guard — both pings fail + zero counters → no recovery dispatch (kithkit#77)', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('(a) quiet period: both probes fail AND no recent messages → updatePeerState NOT called with unreachable/unknown', async () => {
    // Both the direct LAN send and the relay probe fail.
    const fetchMock = makeFetchMock(false); // relay fails
    const commsMock = makeCommsMock(false); // direct send fails

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());
    // Counter override: no recent messages from this peer → quiet period.
    _setGetMessageCountsForTesting(() => ({ inbound: 0, inject: 0 }));

    await _runForTesting();

    const recoveryDispatched = commsMock._calls.updatePeerState.some(
      (c) => c.state.status === 'unreachable' || c.state.status === 'unknown',
    );
    assert.equal(
      recoveryDispatched,
      false,
      `updatePeerState must NOT be called with unreachable/unknown during a quiet period. ` +
      `Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
  });

  it('(b) broken delivery: both probes fail AND inbound > inject → updatePeerState called with unreachable', async () => {
    // Both the direct LAN send and the relay probe fail.
    const fetchMock = makeFetchMock(false);
    const commsMock = makeCommsMock(false);

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());
    // Counter override: peer sent us 3 messages, but none were injected → broken delivery.
    _setGetMessageCountsForTesting(() => ({ inbound: 3, inject: 0 }));

    await _runForTesting();

    const unreachableCall = commsMock._calls.updatePeerState.find(
      (c) => c.state.status === 'unreachable',
    );
    assert.ok(
      unreachableCall !== undefined,
      `updatePeerState must be called with unreachable when broken delivery is detected (inbound=3, inject=0). ` +
      `Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
    assert.equal(unreachableCall!.name, 'bmo');
  });

  it('(c) relay success still suppresses recovery regardless of counters', async () => {
    // Direct LAN fails, but relay probe SUCCEEDS — peer is alive via relay.
    // The quiet-period guard must not interfere with the existing relay-success path.
    const fetchMock = makeFetchMock(true); // relay succeeds
    const commsMock = makeCommsMock(false); // direct send fails

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());
    // Even with non-zero counters, the relay-success path should win.
    _setGetMessageCountsForTesting(() => ({ inbound: 5, inject: 0 }));

    await _runForTesting();

    // Must be marked local-dns-indeterminate, NOT unreachable.
    const unreachableCall = commsMock._calls.updatePeerState.find(
      (c) => c.state.status === 'unreachable' || c.state.status === 'unknown',
    );
    assert.equal(
      unreachableCall,
      undefined,
      `updatePeerState must NOT be called with unreachable/unknown when relay succeeds. ` +
      `Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
    const indeterminate = commsMock._calls.updatePeerState.find(
      (c) => c.state.status === 'local-dns-indeterminate',
    );
    assert.ok(
      indeterminate !== undefined,
      'updatePeerState must be called with local-dns-indeterminate when relay succeeds',
    );
  });
});

// ── t-317: live-ping gate (todo #854 fast-follow) ─────────────────────────────
//
// Root cause: PR #437 added the quiet-period guard (inbound==0 → skip dispatch)
// but when inbound > 0 the recovery was still dispatched unconditionally.  A
// transient delivery failure (relay down, routing glitch) with residual message
// traffic would trigger false-positive recovery.
//
// Fix: when inbound > 0 (looks broken), send a direct live ping to the peer
// before dispatching.  Only declare broken if the live ping also fails.
//
// Mutation-kill: removing the live-ping gate (reverting to "dispatch whenever
// inbound > 0 regardless of live ping result") causes sub-tests (a) and (b) to
// observe unexpected updatePeerState calls, failing the assertion.

describe('t-317: live-ping gate — peer responds to live ping → no recovery dispatch (todo #854 fast-follow)', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('(a) mDNS: both .lan DNS and relay fail + inbound > 0 + live ping OK → no dispatch', async () => {
    // Both the direct LAN send (sendAgentMessage) and the relay probe fail.
    // Message counts show inbound=3 (looks broken).
    // But the live ping succeeds — peer is alive, delivery channel is broken.
    const fetchMock = makeFetchMock(false); // relay fails
    const commsMock = makeCommsMock(false); // direct send fails

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());
    _setGetMessageCountsForTesting(() => ({ inbound: 3, inject: 0 }));
    // Live ping SUCCEEDS — peer responds to direct probe.
    // Mutation: remove the live-ping gate → dispatch triggered → recoveryDispatched = true → RED.
    _setLivePingForTesting(async () => true);

    await _runForTesting();

    const recoveryDispatched = commsMock._calls.updatePeerState.some(
      (c) => c.state.status === 'unreachable' || c.state.status === 'unknown',
    );
    assert.equal(
      recoveryDispatched,
      false,
      `No recovery dispatch when live ping succeeds (peer is alive). ` +
      `Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
  });

  it('(b) non-mDNS: send fails + inbound > 0 + live ping OK → no dispatch', async () => {
    // Non-mDNS IP host: direct heartbeat fails, inbound=3 (looks broken),
    // but live ping succeeds.
    const commsMock = makeCommsMock(false);

    _setLoadConfigForTesting(() => makeNonMdnsConfig());
    _setCommsForTesting(commsMock);
    _setScanForPeersForTesting(async () => new Map());
    _setGetMessageCountsForTesting(() => ({ inbound: 3, inject: 0 }));
    // Live ping SUCCEEDS.
    // Mutation: remove live-ping gate → updatePeerState('unknown') dispatched → RED.
    _setLivePingForTesting(async () => true);

    await _runForTesting();

    const recoveryDispatched = commsMock._calls.updatePeerState.some(
      (c) => c.state.status === 'unreachable' || c.state.status === 'unknown',
    );
    assert.equal(
      recoveryDispatched,
      false,
      `No recovery dispatch when live ping succeeds (non-mDNS). ` +
      `Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
  });

  it('(c) live ping fails + inbound > 0 → dispatch still fires (sanity: gate only suppresses on ping-OK)', async () => {
    // Confirms the gate does not suppress dispatch when the live ping also fails.
    const fetchMock = makeFetchMock(false);
    const commsMock = makeCommsMock(false);

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());
    _setGetMessageCountsForTesting(() => ({ inbound: 3, inject: 0 }));
    // Live ping FAILS (default after _resetForTesting, but explicit for clarity).
    _setLivePingForTesting(async () => false);

    await _runForTesting();

    const unreachableCall = commsMock._calls.updatePeerState.find(
      (c) => c.state.status === 'unreachable',
    );
    assert.ok(
      unreachableCall !== undefined,
      `Recovery must be dispatched when live ping also fails. ` +
      `Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
  });
});

// ── t-318: count-semantics correction (todo #854 fast-follow) ─────────────────
//
// Root cause: the inbound counter in getMessageCounts() included type:status
// rows (heartbeat traffic that is persisted-but-never-injected).  A peer that
// only exchanges heartbeats appeared as inbound > 0 → broken delivery rather
// than inbound == 0 → quiet period.
//
// Fix: (1) add AND type != 'status' to the SQL query so heartbeat rows are
// excluded from inbound; (2) simplify the quiet-period condition to
// `inbound === 0` — inject is always a subset of inbound after the filter
// and is no longer an independent gate.
//
// Mutation-kill: reverting to `inbound === 0 && inject === 0` causes sub-test
// (a) to observe an unexpected dispatch when inject=5 with inbound=0, failing
// the assertion.  The test uses a mocked counter to simulate the scenario
// deterministically without a real DB.

describe('t-318: count-semantics — inbound==0 is the sole quiet-period discriminator (todo #854 fast-follow)', () => {
  beforeEach(() => { _resetForTesting(); });
  afterEach(() => { _resetForTesting(); });

  it('(a) inbound=0 with inject=5 → quiet period, no recovery dispatch', async () => {
    // Scenario: the DB query returns inbound=0 (all recent messages are
    // type:status and are filtered out) but inject=5 (legacy non-zero value,
    // e.g. older injections within the window under a previous schema).
    //
    // With the CORRECTED condition (inbound === 0): quiet → no dispatch. ✓
    // Mutation (revert to inbound === 0 && inject === 0):
    //   inject=5 fails the inject===0 check → not quiet → live ping
    //   (_livePingForTesting defaults to false after _resetForTesting)
    //   → dispatch fires → recoveryDispatched = true → this assertion fails → RED ✓
    const fetchMock = makeFetchMock(false); // relay fails
    const commsMock = makeCommsMock(false); // direct send fails

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());
    // inbound=0 (status-only traffic filtered), inject=5 (residual non-zero).
    _setGetMessageCountsForTesting(() => ({ inbound: 0, inject: 5 }));
    // _livePingForTesting is already () => false from _resetForTesting —
    // if the quiet-period check is bypassed, live ping fails → dispatch fires.

    await _runForTesting();

    const recoveryDispatched = commsMock._calls.updatePeerState.some(
      (c) => c.state.status === 'unreachable' || c.state.status === 'unknown',
    );
    assert.equal(
      recoveryDispatched,
      false,
      `inbound=0 must be treated as quiet period regardless of inject count. ` +
      `With the corrected inbound-only discriminator, type:status-only traffic ` +
      `(inbound=0 after SQL filter) never triggers recovery. ` +
      `Got: ${JSON.stringify(commsMock._calls.updatePeerState)}`,
    );
  });

  it('(b) inbound=0 inject=0 → quiet period (baseline, unchanged from t-316a)', async () => {
    // Confirms the pure-zero case continues to work with the simplified condition.
    const fetchMock = makeFetchMock(false);
    const commsMock = makeCommsMock(false);

    _setLoadConfigForTesting(() => makeLanConfig());
    _setCommsForTesting(commsMock);
    _setFetchForTesting(fetchMock.fn);
    _setScanForPeersForTesting(async () => new Map());
    _setGetMessageCountsForTesting(() => ({ inbound: 0, inject: 0 }));

    await _runForTesting();

    const recoveryDispatched = commsMock._calls.updatePeerState.some(
      (c) => c.state.status === 'unreachable' || c.state.status === 'unknown',
    );
    assert.equal(recoveryDispatched, false, 'inbound=0 inject=0 must remain a quiet period');
  });
});
