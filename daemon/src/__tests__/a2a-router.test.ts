/**
 * UnifiedA2ARouter unit tests — group mismatch detection and PEER_NOT_FOUND errors.
 *
 * Tests the router's ability to detect when a caller accidentally puts a group
 * name in the 'to' field instead of the 'group' field, and returns a helpful
 * error message.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedA2ARouter } from '../a2a/router.js';
import type { RouterDeps, PeerConfig } from '../a2a/router.js';

// ── Mock helpers ──────────────────────────────────────────────

interface MockGroup {
  groupId: string;
  name: string;
  owner: string;
  status: string;
  role: string;
  createdAt: string;
}

function makeNetworkClient(groups: MockGroup[] = []) {
  return {
    send: async (_to: string, _payload: Record<string, unknown>) => ({
      status: 'delivered' as const,
      messageId: 'test-msg-id',
    }),
    sendToGroup: async (_groupId: string, _payload: Record<string, unknown>) => ({
      messageId: 'test-group-msg-id',
      delivered: [],
      queued: [],
      failed: [],
    }),
    getGroups: async () => groups,
  };
}

function makeDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    config: {
      agent: { name: 'test-agent' },
      'agent-comms': {
        enabled: true,
        peers: [
          { name: 'bmo', host: 'bmo.lan', port: 3847 } as PeerConfig,
        ],
      },
      network: {
        communities: [{ name: 'home', primary: 'https://relay.example.com' }],
      },
    },
    sendViaLAN: async () => ({ ok: true }),
    getNetworkClient: () => makeNetworkClient(),
    getAgentCommsSecret: async () => 'test-secret',
    logCommsEntry: () => {},
    sendMessage: () => ({ messageId: 1, delivered: true }),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('UnifiedA2ARouter — group mismatch detection', () => {

  it('returns helpful error when to value matches a known group name', async () => {
    const groups: MockGroup[] = [
      {
        groupId: 'abc-123',
        name: 'home-agents',
        owner: 'bmo',
        status: 'active',
        role: 'member',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const deps = makeDeps({
      getNetworkClient: () => makeNetworkClient(groups),
    });

    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'home-agents',
      payload: { type: 'text', text: 'Team update' },
    });

    assert.equal(result.ok, false);
    const err = result as { ok: false; error: string; code: string };
    assert.equal(err.code, 'PEER_NOT_FOUND');
    assert.ok(
      err.error.includes("'home-agents' is a group, not a peer"),
      `Expected group mismatch message, got: ${err.error}`,
    );
    assert.ok(
      err.error.includes("Use the 'group' field instead of 'to'"),
      `Expected field hint in message, got: ${err.error}`,
    );
  });

  it('group name matching is case-insensitive', async () => {
    const groups: MockGroup[] = [
      {
        groupId: 'abc-123',
        name: 'Home-Agents',
        owner: 'bmo',
        status: 'active',
        role: 'member',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const deps = makeDeps({
      getNetworkClient: () => makeNetworkClient(groups),
    });

    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'home-agents',
      payload: { type: 'text', text: 'Hello' },
    });

    assert.equal(result.ok, false);
    const err = result as { ok: false; error: string; code: string };
    assert.equal(err.code, 'PEER_NOT_FOUND');
    assert.ok(err.error.includes("'home-agents' is a group, not a peer"));
  });

  it('does not return group mismatch when to value is a real peer name', async () => {
    const groups: MockGroup[] = [
      {
        groupId: 'abc-123',
        name: 'home-agents',
        owner: 'bmo',
        status: 'active',
        role: 'member',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const deps = makeDeps({
      getNetworkClient: () => makeNetworkClient(groups),
      // sendViaLAN returns ok for the configured peer 'bmo'
      sendViaLAN: async () => ({ ok: true }),
    });

    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'bmo',
      payload: { type: 'text', text: 'Hello BMO' },
    });

    assert.equal(result.ok, true, 'DM to known peer should succeed');
    const res = result as { ok: true; targetType: string };
    assert.equal(res.targetType, 'dm');
  });

  it('does not return group mismatch when no groups exist', async () => {
    const deps = makeDeps({
      getNetworkClient: () => makeNetworkClient([]),
      // Relay will handle unknown peer
      sendViaLAN: async () => ({ ok: false, error: 'not in config' }),
    });

    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'unknown-peer',
      payload: { type: 'text', text: 'Hello' },
    });

    // Should not get a group mismatch error — any other failure is fine
    if (!result.ok) {
      const err = result as { ok: false; error: string; code: string };
      assert.ok(
        !err.error.includes('is a group, not a peer'),
        `Should not get group mismatch error for unknown name when no groups match: ${err.error}`,
      );
    }
  });

  it('skips group check gracefully when network client is unavailable', async () => {
    const deps = makeDeps({
      getNetworkClient: () => null,
    });

    const router = new UnifiedA2ARouter(deps);
    const result = await router.send({
      to: 'home-agents',
      payload: { type: 'text', text: 'Hello' },
    });

    // No network client — group check skipped, falls through to relay attempt
    // which also fails since client is null — gets DELIVERY_FAILED, not group mismatch
    if (!result.ok) {
      const err = result as { ok: false; error: string };
      assert.ok(
        !err.error.includes('is a group, not a peer'),
        `Should not get group mismatch error when network client is null: ${err.error}`,
      );
    }
  });

  it('skips group check gracefully when getGroups throws', async () => {
    const failingClient = {
      ...makeNetworkClient([]),
      getGroups: async () => { throw new Error('Network unavailable'); },
    };

    const deps = makeDeps({
      getNetworkClient: () => failingClient,
    });

    const router = new UnifiedA2ARouter(deps);
    // Should not throw — the error is swallowed
    const result = await router.send({
      to: 'home-agents',
      payload: { type: 'text', text: 'Hello' },
    });

    // Result can be success or failure but must not throw
    assert.ok(result !== undefined, 'Should return a result even when getGroups fails');
    if (!result.ok) {
      const err = result as { ok: false; error: string };
      assert.ok(
        !err.error.includes('is a group, not a peer'),
        'Should not get group mismatch error when getGroups throws',
      );
    }
  });

});
