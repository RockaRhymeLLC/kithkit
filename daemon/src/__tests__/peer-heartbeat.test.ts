/**
 * t-310: isMdnsHost correctly classifies hostnames
 * t-311: relay probe attempted before peer is marked down on .lan/.local failure
 * t-312: peer NOT marked down / failed NOT incremented when relay probe succeeds
 * t-313: peer marked unreachable when both .lan DNS and relay fail
 * t-314: updatePeerState exported from agent-comms + called on successful heartbeat (Fix 1 mutation-kill)
 * t-315: relay-fallback removal causes t-312 / t-313 assertions to fail (Fix 2 mutation-kill — see report)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMdnsHost,
  _setCommsForTesting,
  _setFetchForTesting,
  _setLoadConfigForTesting,
  _setScanForPeersForTesting,
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
        { name: 'bmo', host: 'bmo-mini.lan', port: 3847 },
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
        { name: 'bmo', host: '192.168.1.50', port: 3847 },
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
    assert.equal(isMdnsHost('bmo-mini.lan'), true);
    assert.equal(isMdnsHost('peer.lan'), true);
    assert.equal(isMdnsHost('device.something.lan'), true);
  });

  it('returns true for .local hostnames', () => {
    assert.equal(isMdnsHost('macbook.local'), true);
    assert.equal(isMdnsHost('server.local'), true);
  });

  it('returns false for IP addresses', () => {
    assert.equal(isMdnsHost('192.168.1.1'), false);
    assert.equal(isMdnsHost('10.0.0.50'), false);
  });

  it('returns false for regular domain names', () => {
    assert.equal(isMdnsHost('peer.example.com'), false);
    assert.equal(isMdnsHost('relay.bmobot.ai'), false);
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
