/**
 * Delivery-integrity layer tests (#585 / #620).
 *
 * Verifies the three components ported from the daemon's sdk-bridge.ts:
 *
 *   1. persist-on-receive: persistFn is called BEFORE the 'message' /
 *      'group-message' event fires (persist-before-deliver semantics).
 *      Daemon seam: wireMessageEvent / wireGroupMessageEvent sendMessage() call
 *      in daemon/src/extensions/comms/network/sdk-bridge.ts.
 *
 *   2. Idempotent injected_at stamping: a messageId that has already been
 *      injected is not re-persisted or re-emitted on duplicate delivery.
 *
 *   3. Dead-letter: if persistFn throws, the message is NOT emitted; it lands
 *      in the dead-letter queue (getDeadLetterQueue()).
 *
 * Mutation-kill contract: temporarily reverting the `await this.persistFn(msg)`
 * line in receiveMessage / receiveGroupMessage must turn tests 1a and 2a RED.
 * This is documented in the task-660 final report.
 *
 * Test design: no injected seam — we exercise the REAL persist path by
 * providing a persistFn to the constructor and asserting its call count and
 * ordering against a distinct sentinel value that cannot arise from the
 * default/unconfigured state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { A2ANetwork, type A2ANetworkInternalOptions } from '../client.js';
import type { IRelayAPI, RelayContact, RelayPendingRequest, RelayResponse } from '../relay-api.js';
import type { Message, GroupMessage, DeadLetterEntry } from '../types.js';
import { buildEnvelope } from '../messaging.js';
import { createPrivateKey } from 'node:crypto';

import { initializeDatabase } from 'kithkit-a2a-relay/dist/db.js';
import {
  requestContact as relayRequestContact,
  acceptContact as relayAcceptContact,
  listContacts as relayListContacts,
  listPendingRequests as relayPendingRequests,
} from 'kithkit-a2a-relay/dist/routes/contacts.js';
import {
  updatePresence as relayUpdatePresence,
} from 'kithkit-a2a-relay/dist/routes/presence.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: kp.privateKey,
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
    privateKeyDer: kp.privateKey.export({ type: 'pkcs8', format: 'der' }),
    privateKeyObj: kp.privateKey,
  };
}

function createActiveAgent(
  db: ReturnType<typeof initializeDatabase>,
  name: string,
  publicKeyBase64: string,
  endpoint?: string,
) {
  db.prepare(
    "INSERT INTO agents (name, public_key, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, 1, 'active', 'test-admin', datetime('now'))",
  ).run(name, publicKeyBase64, endpoint ?? null);
}

class MockRelayAPI implements IRelayAPI {
  constructor(
    private db: ReturnType<typeof initializeDatabase>,
    private agentName: string,
  ) {}

  async requestContact(toAgent: string): Promise<RelayResponse> {
    const result = relayRequestContact(this.db, this.agentName, toAgent);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }
  async acceptContact(agent: string): Promise<RelayResponse> {
    const result = relayAcceptContact(this.db, this.agentName, agent);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }
  async denyContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async removeContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async getContacts(): Promise<RelayResponse<RelayContact[]>> {
    return { ok: true, status: 200, data: relayListContacts(this.db, this.agentName) };
  }
  async getPendingRequests(): Promise<RelayResponse<RelayPendingRequest[]>> {
    return { ok: true, status: 200, data: relayPendingRequests(this.db, this.agentName) };
  }
  async heartbeat(endpoint: string): Promise<RelayResponse> {
    relayUpdatePresence(this.db, this.agentName, endpoint);
    return { ok: true, status: 200 };
  }
  async createBroadcast(): Promise<RelayResponse<{ broadcastId: string }>> { return { ok: false, status: 403, error: 'stub' }; }
  async listBroadcasts(): Promise<RelayResponse<import('../relay-api.js').RelayBroadcast[]>> { return { ok: true, status: 200, data: [] }; }
  async revokeAgent(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async rotateKey(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async recoverKey(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async createGroup(): Promise<RelayResponse<import('../relay-api.js').RelayGroup>> { return { ok: false, status: 403, error: 'stub' }; }
  async getGroup(): Promise<RelayResponse<import('../relay-api.js').RelayGroup>> { return { ok: false, status: 403, error: 'stub' }; }
  async listGroups(): Promise<RelayResponse<import('../relay-api.js').RelayGroup[]>> { return { ok: true, status: 200, data: [] }; }
  async inviteToGroup(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async acceptGroupInvitation(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async declineGroupInvitation(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async leaveGroup(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async removeMember(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async dissolveGroup(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
  async getGroupMembers(): Promise<RelayResponse<import('../relay-api.js').RelayGroupMember[]>> { return { ok: true, status: 200, data: [] }; }
  async getGroupInvitations(): Promise<RelayResponse<import('../relay-api.js').RelayGroupInvitation[]>> { return { ok: true, status: 200, data: [] }; }
  async transferGroupOwnership(): Promise<RelayResponse> { return { ok: false, status: 403, error: 'stub' }; }
}

interface IntegrityTestEnv {
  dir: string;
  db: ReturnType<typeof initializeDatabase>;
  aliceKeys: ReturnType<typeof genKeypair>;
  bobKeys: ReturnType<typeof genKeypair>;
  aliceRelay: MockRelayAPI;
  bobRelay: MockRelayAPI;
  networks: A2ANetwork[];
}

function setupEnv(): IntegrityTestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'di-test-'));
  const db = initializeDatabase(':memory:');

  const aliceKeys = genKeypair();
  const bobKeys = genKeypair();

  createActiveAgent(db, 'alice', aliceKeys.publicKeyBase64, 'https://alice.example.com/inbox');
  createActiveAgent(db, 'bob', bobKeys.publicKeyBase64, 'https://bob.example.com/inbox');
  relayUpdatePresence(db, 'alice', 'https://alice.example.com/inbox');
  relayUpdatePresence(db, 'bob', 'https://bob.example.com/inbox');

  return {
    dir,
    db,
    aliceKeys,
    bobKeys,
    aliceRelay: new MockRelayAPI(db, 'alice'),
    bobRelay: new MockRelayAPI(db, 'bob'),
    networks: [],
  };
}

function makeNetwork(
  env: IntegrityTestEnv,
  agent: 'alice' | 'bob',
  extra?: Partial<A2ANetworkInternalOptions>,
): A2ANetwork {
  const keys = agent === 'alice' ? env.aliceKeys : env.bobKeys;
  const relay = agent === 'alice' ? env.aliceRelay : env.bobRelay;
  const dataDir = join(env.dir, `${agent}-data`);

  const network = new A2ANetwork({
    relayUrl: 'http://localhost:0',
    username: agent,
    privateKey: Buffer.from(keys.privateKeyDer),
    endpoint: `https://${agent}.example.com/inbox`,
    dataDir,
    heartbeatInterval: 60_000,
    relayAPI: relay,
    deliverFn: async () => false, // no-op — tests call receiveMessage directly
    ...extra,
  } as A2ANetworkInternalOptions);

  env.networks.push(network);
  return network;
}

/** Build a signed, encrypted envelope from alice to bob and return it. */
function buildAliceToBobEnvelope(
  env: IntegrityTestEnv,
  messageId: string,
  payload: Record<string, unknown>,
) {
  const alicePrivObj = createPrivateKey({
    key: Buffer.from(env.aliceKeys.privateKeyDer),
    format: 'der',
    type: 'pkcs8',
  });
  return buildEnvelope({
    sender: 'alice',
    recipient: 'bob',
    payload,
    senderPrivateKey: alicePrivObj,
    recipientPublicKeyBase64: env.bobKeys.publicKeyBase64,
    messageId,
    type: 'direct',
  });
}

async function teardown(env: IntegrityTestEnv) {
  for (const n of env.networks) {
    await n.stop().catch(() => {});
  }
  rmSync(env.dir, { recursive: true, force: true });
}

async function establishContacts(alice: A2ANetwork, bob: A2ANetwork) {
  await alice.requestContact('bob');
  await bob.acceptContact('alice');
  // Refresh caches so both sides have each other's public keys
  await alice.getContacts();
  await bob.getContacts();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('delivery-integrity: persist-on-receive (#585 / #620)', () => {

  /**
   * 1a. MUTATION-KILL TARGET (direct messages):
   *
   * persistFn is called before 'message' fires. The sentinel is the call-order
   * log — persistFn records 'persist' before the listener records 'event'. If
   * the `await this.persistFn(msg)` line is removed from receiveMessage, the
   * log will be ['event'] (or empty), causing this test to fail RED.
   */
  it('1a. persistFn is called before message event fires (direct)', async () => {
    const env = setupEnv();
    try {
      const callOrder: string[] = [];
      const persistFn = async (msg: Message | GroupMessage) => {
        // Sentinel: must appear BEFORE 'event' in callOrder
        callOrder.push(`persist:${msg.messageId}`);
      };

      const bob = makeNetwork(env, 'bob', { persistFn });
      const alice = makeNetwork(env, 'alice');

      await alice.start();
      await bob.start();
      await establishContacts(alice, bob);

      bob.on('message', (msg) => {
        callOrder.push(`event:${msg.messageId}`);
      });

      const envelope = buildAliceToBobEnvelope(env, 'msg-di-001', { text: 'hello' });
      const result = await bob.receiveMessage(envelope);

      // DISTINCT-FROM-DEFAULT assertion: persistFn must have been called.
      // If the persist seam is removed, callOrder will be ['event:msg-di-001']
      // or [] — both will fail this check.
      assert.ok(
        callOrder.length >= 2,
        `Expected at least 2 call-order entries (persist + event), got ${callOrder.length}: ${JSON.stringify(callOrder)}`,
      );
      assert.equal(callOrder[0], 'persist:msg-di-001', `persistFn must fire FIRST; got: ${JSON.stringify(callOrder)}`);
      assert.equal(callOrder[1], 'event:msg-di-001', `'message' event must fire AFTER persistFn; got: ${JSON.stringify(callOrder)}`);

      // injectedAt must be set (distinct from undefined/unconfigured)
      assert.ok(result.injectedAt, `injectedAt must be set after injection; got: ${result.injectedAt}`);
      assert.match(result.injectedAt, /^\d{4}-\d{2}-\d{2}T/, 'injectedAt must be an ISO timestamp');
    } finally {
      await teardown(env);
    }
  });

  /**
   * 2a. MUTATION-KILL TARGET (idempotency — direct):
   *
   * A duplicate delivery (same messageId) must NOT re-invoke persistFn or
   * re-emit the event. If the seenMessageIds dedup check is removed from
   * receiveMessage, persistCalls will be 2, failing the assert.equal(1).
   */
  it('2a. duplicate messageId skips persist and re-emit (idempotent injection)', async () => {
    const env = setupEnv();
    try {
      let persistCalls = 0;
      const persistFn = async (_msg: Message | GroupMessage) => {
        persistCalls++;
      };

      const bob = makeNetwork(env, 'bob', { persistFn });
      const alice = makeNetwork(env, 'alice');

      await alice.start();
      await bob.start();
      await establishContacts(alice, bob);

      const emittedMessages: Message[] = [];
      bob.on('message', (msg) => emittedMessages.push(msg));

      const envelope = buildAliceToBobEnvelope(env, 'msg-di-dup-001', { text: 'idempotent' });

      // First delivery — should persist + emit
      await bob.receiveMessage(envelope);
      // Duplicate delivery — must be a no-op
      await bob.receiveMessage(envelope);

      // persistFn must be called exactly once (idempotency)
      assert.equal(persistCalls, 1, `persistFn called ${persistCalls} times; expected exactly 1`);
      // 'message' event emitted exactly once
      assert.equal(emittedMessages.length, 1, `message event emitted ${emittedMessages.length} times; expected 1`);
    } finally {
      await teardown(env);
    }
  });

  /**
   * 3. Dead-letter: if persistFn throws, message is NOT emitted and lands
   *    in the dead-letter queue.
   */
  it('3. persistFn error dead-letters message — event is NOT emitted', async () => {
    const env = setupEnv();
    try {
      const persistFn = async (_msg: Message | GroupMessage) => {
        throw new Error('DB connection lost');
      };

      const bob = makeNetwork(env, 'bob', { persistFn });
      const alice = makeNetwork(env, 'alice');

      await alice.start();
      await bob.start();
      await establishContacts(alice, bob);

      const emittedMessages: Message[] = [];
      bob.on('message', (msg) => emittedMessages.push(msg));

      const envelope = buildAliceToBobEnvelope(env, 'msg-di-dl-001', { text: 'dead-letter me' });
      await bob.receiveMessage(envelope);

      // 'message' event must NOT have fired
      assert.equal(emittedMessages.length, 0, 'message event must not fire when persistFn throws');

      // Dead-letter queue must have exactly one entry
      const dlq = bob.getDeadLetterQueue();
      assert.equal(dlq.length, 1, `dead-letter queue must have 1 entry; got ${dlq.length}`);
      assert.equal(dlq[0]!.messageId, 'msg-di-dl-001');
      assert.match(dlq[0]!.error, /DB connection lost/);
      assert.ok(dlq[0]!.receivedAt, 'dead-letter entry must have receivedAt');

      // clearDeadLetterQueue works
      bob.clearDeadLetterQueue();
      assert.equal(bob.getDeadLetterQueue().length, 0, 'queue must be empty after clear');
    } finally {
      await teardown(env);
    }
  });

  /**
   * 4. Backward-compatibility: no persistFn → events fire as before (no regression).
   */
  it('4. no persistFn — message event fires without error (backward-compat)', async () => {
    const env = setupEnv();
    try {
      const bob = makeNetwork(env, 'bob'); // no persistFn
      const alice = makeNetwork(env, 'alice');

      await alice.start();
      await bob.start();
      await establishContacts(alice, bob);

      const emittedMessages: Message[] = [];
      bob.on('message', (msg) => emittedMessages.push(msg));

      const envelope = buildAliceToBobEnvelope(env, 'msg-di-bc-001', { text: 'backward compat' });
      const result = await bob.receiveMessage(envelope);

      assert.equal(emittedMessages.length, 1, 'message must be emitted without persistFn');
      assert.deepEqual(emittedMessages[0]!.payload, { text: 'backward compat' });
      // injectedAt still set (even without persistFn)
      assert.ok(result.injectedAt, 'injectedAt must be set even without persistFn');
    } finally {
      await teardown(env);
    }
  });

  /**
   * 1b. persist-on-receive: group messages (mirrors wireGroupMessageEvent seam).
   *
   * MUTATION-KILL TARGET: removing `await this.persistFn(msg)` from
   * receiveGroupMessage makes callOrder[0] === 'event:...' instead of
   * 'persist:...', failing the assertion.
   */
  it('1b. persistFn is called before group-message event fires', async () => {
    const env = setupEnv();
    try {
      const callOrder: string[] = [];
      const persistFn = async (msg: Message | GroupMessage) => {
        callOrder.push(`persist:${msg.messageId}`);
      };

      const bob = makeNetwork(env, 'bob', { persistFn });
      const alice = makeNetwork(env, 'alice');

      await alice.start();
      await bob.start();
      await establishContacts(alice, bob);

      bob.on('group-message', (msg) => {
        callOrder.push(`event:${msg.messageId}`);
      });

      // Build a group envelope directly (bypasses group membership check via cache manipulation)
      const alicePrivObj = createPrivateKey({
        key: Buffer.from(env.aliceKeys.privateKeyDer),
        format: 'der',
        type: 'pkcs8',
      });
      const groupId = 'test-group-di-001';
      const groupMsgId = 'gmsg-di-001';

      // Pre-populate bob's member cache so membership check passes without relay
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bob as any).memberCache.set(groupId, {
        members: [{ agent: 'alice' }, { agent: 'bob' }],
        fetchedAt: Date.now(),
      });

      const groupEnvelope = buildEnvelope({
        sender: 'alice',
        recipient: 'bob',
        payload: { text: 'group persist test' },
        senderPrivateKey: alicePrivObj,
        recipientPublicKeyBase64: env.bobKeys.publicKeyBase64,
        messageId: groupMsgId,
        type: 'group',
        groupId,
      });

      const result = await bob.receiveGroupMessage(groupEnvelope);

      assert.ok(result, 'receiveGroupMessage must return the message');
      assert.ok(
        callOrder.length >= 2,
        `Expected >= 2 entries (persist + event), got ${callOrder.length}: ${JSON.stringify(callOrder)}`,
      );
      assert.equal(callOrder[0], `persist:${groupMsgId}`, `persistFn must fire FIRST; got: ${JSON.stringify(callOrder)}`);
      assert.equal(callOrder[1], `event:${groupMsgId}`, `group-message event must fire AFTER persistFn; got: ${JSON.stringify(callOrder)}`);
      assert.ok(result.injectedAt, 'injectedAt must be set on group message');
    } finally {
      await teardown(env);
    }
  });

  /**
   * 2b. Idempotency: duplicate group messageId skips persist + re-emit.
   */
  it('2b. duplicate group messageId skips persist and re-emit', async () => {
    const env = setupEnv();
    try {
      let persistCalls = 0;
      const persistFn = async (_msg: Message | GroupMessage) => { persistCalls++; };

      const bob = makeNetwork(env, 'bob', { persistFn });
      const alice = makeNetwork(env, 'alice');

      await alice.start();
      await bob.start();
      await establishContacts(alice, bob);

      const emitted: GroupMessage[] = [];
      bob.on('group-message', (msg) => emitted.push(msg));

      const alicePrivObj = createPrivateKey({
        key: Buffer.from(env.aliceKeys.privateKeyDer),
        format: 'der',
        type: 'pkcs8',
      });
      const groupId = 'test-group-di-dup';
      const groupMsgId = 'gmsg-di-dup-001';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bob as any).memberCache.set(groupId, {
        members: [{ agent: 'alice' }, { agent: 'bob' }],
        fetchedAt: Date.now(),
      });

      const groupEnvelope = buildEnvelope({
        sender: 'alice',
        recipient: 'bob',
        payload: { text: 'dup group' },
        senderPrivateKey: alicePrivObj,
        recipientPublicKeyBase64: env.bobKeys.publicKeyBase64,
        messageId: groupMsgId,
        type: 'group',
        groupId,
      });

      await bob.receiveGroupMessage(groupEnvelope);
      const secondResult = await bob.receiveGroupMessage(groupEnvelope); // duplicate

      assert.equal(persistCalls, 1, `persistFn called ${persistCalls} times; expected 1`);
      assert.equal(emitted.length, 1, `group-message emitted ${emitted.length} times; expected 1`);
      assert.equal(secondResult, null, 'duplicate must return null');
    } finally {
      await teardown(env);
    }
  });

});
