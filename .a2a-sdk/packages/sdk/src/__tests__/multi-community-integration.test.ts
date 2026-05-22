/**
 * Multi-community integration tests.
 *
 * t-110: Key rotation with shared keypairs fans out to correct communities
 * t-112: Multi-community E2E integration (send, receive, failover, isolation)
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { A2ANetwork, type A2ANetworkInternalOptions } from '../client.js';
import type { IRelayAPI, RelayResponse, RelayContact, RelayPendingRequest, RelayBroadcast, RelayGroup, RelayGroupMember, RelayGroupInvitation, RelayGroupChange } from '../relay-api.js';
import type { CommunityConfig, WireEnvelope, KeyRotationResult } from '../types.js';

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  return {
    privateKey: kp.privateKey,
    publicKeyBase64: Buffer.from(kp.publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    privateKeyDer: kp.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer,
    publicKeyDer: kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
  };
}

/** Create a mock relay API with optional overrides. */
function createMockRelayAPI(overrides?: Partial<IRelayAPI>): IRelayAPI {
  const notCalled = async (): Promise<RelayResponse> => ({ ok: true, status: 200 });
  return {
    requestContact: notCalled,
    acceptContact: notCalled,
    denyContact: notCalled,
    removeContact: notCalled,
    getContacts: async () => ({ ok: true, status: 200, data: [] as RelayContact[] }),
    getPendingRequests: async () => ({ ok: true, status: 200, data: [] as RelayPendingRequest[] }),
    heartbeat: notCalled,
    createBroadcast: async () => ({ ok: true, status: 200, data: { broadcastId: 'b1' } }),
    listBroadcasts: async () => ({ ok: true, status: 200, data: [] as RelayBroadcast[] }),
    revokeAgent: notCalled,
    rotateKey: notCalled,
    recoverKey: notCalled,
    createGroup: async () => ({ ok: true, status: 200, data: { groupId: 'g1', name: 'test', owner: 'a', status: 'active', createdAt: '' } as RelayGroup }),
    getGroup: async () => ({ ok: true, status: 200, data: { groupId: 'g1', name: 'test', owner: 'a', status: 'active', createdAt: '' } as RelayGroup }),
    inviteToGroup: notCalled,
    acceptGroupInvitation: notCalled,
    declineGroupInvitation: notCalled,
    leaveGroup: notCalled,
    removeMember: notCalled,
    dissolveGroup: notCalled,
    listGroups: async () => ({ ok: true, status: 200, data: [] as RelayGroup[] }),
    getGroupMembers: async () => ({ ok: true, status: 200, data: [] as RelayGroupMember[] }),
    getGroupInvitations: async () => ({ ok: true, status: 200, data: [] as RelayGroupInvitation[] }),
    getGroupChanges: async () => ({ ok: true, status: 200, data: [] as RelayGroupChange[] }),
    transferGroupOwnership: notCalled,
    ...overrides,
  };
}

function createContactsMockRelayAPI(contacts: RelayContact[]): IRelayAPI {
  return createMockRelayAPI({
    getContacts: async () => ({ ok: true, status: 200, data: contacts }),
  });
}

// ─── t-110: Key rotation with shared keypairs fans out ────────────────────────

describe('t-110: Key rotation with shared keypairs fans out', () => {
  const defaultKp = genKeypair();
  const companyKp = genKeypair();
  const newKp = genKeypair();
  const newCompanyKp = genKeypair();
  let cleanups: Array<{ dir: string; networks: A2ANetwork[] }> = [];

  afterEach(async () => {
    for (const { networks, dir } of cleanups) {
      for (const n of networks) {
        try { await n.stop(); } catch { /* ignore */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    cleanups = [];
  });

  function track(dir: string, ...networks: A2ANetwork[]) {
    cleanups.push({ dir, networks });
  }

  // Step 1: Call rotateKey() for default key → home + public called, company NOT
  it('step 1: rotateKey fans out to communities sharing default keypair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2a-rotate1-'));
    const dataDir = join(dir, 'data');

    const rotatedRelays: string[] = [];

    const homeMock = createMockRelayAPI({
      rotateKey: async () => { rotatedRelays.push('home'); return { ok: true, status: 200 }; },
    });
    const publicMock = createMockRelayAPI({
      rotateKey: async () => { rotatedRelays.push('public'); return { ok: true, status: 200 }; },
    });
    const companyMock = createMockRelayAPI({
      rotateKey: async () => { rotatedRelays.push('company'); return { ok: true, status: 200 }; },
    });

    const net = new A2ANetwork({
      username: 'bmo',
      privateKey: defaultKp.privateKeyDer,
      endpoint: 'https://bmo.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai' },
        { name: 'public', primary: 'https://relay.public.ai' },
        { name: 'company', primary: 'https://relay.acme.com', privateKey: companyKp.privateKeyDer },
      ],
      relayAPIs: {
        'home:primary': homeMock,
        'public:primary': publicMock,
        'company:primary': companyMock,
      },
      deliverFn: async () => true,
      dataDir,
    } as A2ANetworkInternalOptions);
    track(dir, net);

    // rotateKey() with no options → default key communities only
    const result = await net.rotateKey(newKp.publicKeyBase64);

    assert.deepEqual(rotatedRelays.sort(), ['home', 'public']);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every(r => r.success));
  });

  // Step 2: Verify rotation payloads — both relays receive same new public key
  it('step 2: both relays receive the same new public key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2a-rotate2-'));
    const dataDir = join(dir, 'data');

    const receivedKeys: string[] = [];

    const homeMock = createMockRelayAPI({
      rotateKey: async (_name: string, newPk: string) => { receivedKeys.push(newPk); return { ok: true, status: 200 }; },
    });
    const publicMock = createMockRelayAPI({
      rotateKey: async (_name: string, newPk: string) => { receivedKeys.push(newPk); return { ok: true, status: 200 }; },
    });

    const net = new A2ANetwork({
      username: 'bmo',
      privateKey: defaultKp.privateKeyDer,
      endpoint: 'https://bmo.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai' },
        { name: 'public', primary: 'https://relay.public.ai' },
      ],
      relayAPIs: {
        'home:primary': homeMock,
        'public:primary': publicMock,
      },
      deliverFn: async () => true,
      dataDir,
    } as A2ANetworkInternalOptions);
    track(dir, net);

    await net.rotateKey(newKp.publicKeyBase64);

    assert.equal(receivedKeys.length, 2);
    assert.equal(receivedKeys[0], newKp.publicKeyBase64);
    assert.equal(receivedKeys[1], newKp.publicKeyBase64);
  });

  // Step 3: Partial failure — home fails, public succeeds → event emitted
  it('step 3: partial failure emits event with per-community results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2a-rotate3-'));
    const dataDir = join(dir, 'data');

    const homeMock = createMockRelayAPI({
      rotateKey: async () => ({ ok: false, status: 500, error: 'Server error' }),
    });
    const publicMock = createMockRelayAPI({
      rotateKey: async () => ({ ok: true, status: 200 }),
    });

    const net = new A2ANetwork({
      username: 'bmo',
      privateKey: defaultKp.privateKeyDer,
      endpoint: 'https://bmo.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai' },
        { name: 'public', primary: 'https://relay.public.ai' },
      ],
      relayAPIs: {
        'home:primary': homeMock,
        'public:primary': publicMock,
      },
      deliverFn: async () => true,
      dataDir,
    } as A2ANetworkInternalOptions);
    track(dir, net);

    // Track emitted events
    const partialEvents: Array<{ results: Array<{ community: string; success: boolean; error?: string }> }> = [];
    net.on('key:rotation-partial' as any, (e: any) => partialEvents.push(e));

    const result = await net.rotateKey(newKp.publicKeyBase64);

    // Should not throw — partial success
    assert.equal(result.results.length, 2);

    // Home failed
    const homeResult = result.results.find(r => r.community === 'home')!;
    assert.equal(homeResult.success, false);
    assert.ok(homeResult.error);

    // Public succeeded
    const publicResult = result.results.find(r => r.community === 'public')!;
    assert.equal(publicResult.success, true);

    // Partial event emitted
    assert.equal(partialEvents.length, 1);
    assert.equal(partialEvents[0]!.results.length, 2);
  });

  // Step 4: Rotate company's independent keypair → only company called
  it('step 4: independent keypair rotation targets only that community', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2a-rotate4-'));
    const dataDir = join(dir, 'data');

    const rotatedRelays: string[] = [];

    const homeMock = createMockRelayAPI({
      rotateKey: async () => { rotatedRelays.push('home'); return { ok: true, status: 200 }; },
    });
    const publicMock = createMockRelayAPI({
      rotateKey: async () => { rotatedRelays.push('public'); return { ok: true, status: 200 }; },
    });
    const companyMock = createMockRelayAPI({
      rotateKey: async () => { rotatedRelays.push('company'); return { ok: true, status: 200 }; },
    });

    const net = new A2ANetwork({
      username: 'bmo',
      privateKey: defaultKp.privateKeyDer,
      endpoint: 'https://bmo.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai' },
        { name: 'public', primary: 'https://relay.public.ai' },
        { name: 'company', primary: 'https://relay.acme.com', privateKey: companyKp.privateKeyDer },
      ],
      relayAPIs: {
        'home:primary': homeMock,
        'public:primary': publicMock,
        'company:primary': companyMock,
      },
      deliverFn: async () => true,
      dataDir,
    } as A2ANetworkInternalOptions);
    track(dir, net);

    // Rotate company's key explicitly
    const result = await net.rotateKey(newCompanyKp.publicKeyBase64, { communities: ['company'] });

    assert.deepEqual(rotatedRelays, ['company']);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.community, 'company');
    assert.equal(result.results[0]!.success, true);
  });
});

// ─── t-112: Multi-community E2E integration ──────────────────────────────────

describe('t-112: Multi-community E2E integration (send, receive, failover, isolation)', () => {
  const aliceKp = genKeypair();
  const bobKp = genKeypair();
  let cleanups: Array<{ dir: string; networks: A2ANetwork[] }> = [];

  afterEach(async () => {
    for (const { networks, dir } of cleanups) {
      for (const n of networks) {
        try { await n.stop(); } catch { /* ignore */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    cleanups = [];
  });

  function track(dir: string, ...networks: A2ANetwork[]) {
    cleanups.push({ dir, networks });
  }

  /**
   * Create a controllable mock relay that tracks calls and allows response control.
   */
  function createControllableRelay(contacts: RelayContact[]) {
    let contactsResponse: RelayResponse<RelayContact[]> = { ok: true, status: 200, data: contacts };
    let heartbeatResponse: RelayResponse = { ok: true, status: 200 };
    const calls: string[] = [];

    const api = createMockRelayAPI({
      getContacts: async () => { calls.push('getContacts'); return contactsResponse; },
      heartbeat: async () => { calls.push('heartbeat'); return heartbeatResponse; },
      requestContact: async (name: string) => { calls.push(`requestContact:${name}`); return { ok: true, status: 200 }; },
    });

    return {
      api,
      calls,
      setContactsResponse: (resp: RelayResponse<RelayContact[]>) => { contactsResponse = resp; },
      setHeartbeatResponse: (resp: RelayResponse) => { heartbeatResponse = resp; },
    };
  }

  // Step 1: Set up 2 agents on 2 communities
  it('step 1: agents initialize with correct community configs', async () => {
    const aliceDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-alice-'));
    const bobDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-bob-'));

    // Alice is on both home + company, Bob is on home only
    const alice = new A2ANetwork({
      username: 'alice',
      privateKey: aliceKp.privateKeyDer,
      endpoint: 'https://alice.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.home.ai', failover: 'https://backup.home.ai' },
        { name: 'company', primary: 'https://relay.acme.com' },
      ],
      relayAPIs: {
        'home:primary': createContactsMockRelayAPI([
          { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
        ]),
        'home:failover': createContactsMockRelayAPI([
          { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
        ]),
        'company:primary': createContactsMockRelayAPI([]),
      },
      deliverFn: async () => true,
      dataDir: join(aliceDir, 'data'),
    } as A2ANetworkInternalOptions);

    const bob = new A2ANetwork({
      username: 'bob',
      privateKey: bobKp.privateKeyDer,
      endpoint: 'https://bob.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.home.ai', failover: 'https://backup.home.ai' },
      ],
      relayAPIs: {
        'home:primary': createContactsMockRelayAPI([
          { agent: 'alice', publicKey: aliceKp.publicKeyBase64, endpoint: 'https://alice.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
        ]),
        'home:failover': createContactsMockRelayAPI([
          { agent: 'alice', publicKey: aliceKp.publicKeyBase64, endpoint: 'https://alice.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
        ]),
      },
      deliverFn: async () => true,
      dataDir: join(bobDir, 'data'),
    } as A2ANetworkInternalOptions);

    track(aliceDir, alice);
    track(bobDir, bob);

    assert.equal(alice.communities.length, 2);
    assert.equal(alice.communities[0].name, 'home');
    assert.equal(alice.communities[1].name, 'company');
    assert.equal(bob.communities.length, 1);
    assert.equal(bob.communities[0].name, 'home');
  });

  // Step 2: Alice sends message to Bob on home community
  it('step 2: message delivered via P2P on home community', async () => {
    const aliceDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-send-'));
    const bobDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-recv-'));

    let deliveredEndpoint: string | null = null;
    let deliveredEnvelope: WireEnvelope | null = null;

    const alice = new A2ANetwork({
      username: 'alice',
      privateKey: aliceKp.privateKeyDer,
      endpoint: 'https://alice.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.home.ai', failover: 'https://backup.home.ai' },
        { name: 'company', primary: 'https://relay.acme.com' },
      ],
      relayAPIs: {
        'home:primary': createContactsMockRelayAPI([
          { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
        ]),
        'home:failover': createContactsMockRelayAPI([
          { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
        ]),
        'company:primary': createContactsMockRelayAPI([]),
      },
      deliverFn: async (endpoint, envelope) => {
        deliveredEndpoint = endpoint;
        deliveredEnvelope = envelope;
        return true;
      },
      dataDir: join(aliceDir, 'data'),
    } as A2ANetworkInternalOptions);
    track(aliceDir, alice);
    track(bobDir);

    await alice.start();

    const result = await alice.send('bob', { text: 'Hello from home!' });
    assert.equal(result.status, 'delivered');
    assert.equal(deliveredEndpoint, 'https://bob.example.com/inbox');
    assert.ok(deliveredEnvelope);
    assert.equal(deliveredEnvelope!.sender, 'alice');
    assert.equal(deliveredEnvelope!.recipient, 'bob');
  });

  // Step 3: Bob NOT visible as contact on Alice's company community
  // Verify via cache: Bob exists in home cache but NOT in company cache
  it('step 3: cross-community isolation — Bob not in company cache', async () => {
    const aliceDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-iso-'));

    const alice = new A2ANetwork({
      username: 'alice',
      privateKey: aliceKp.privateKeyDer,
      endpoint: 'https://alice.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.home.ai' },
        { name: 'company', primary: 'https://relay.acme.com' },
      ],
      relayAPIs: {
        'home:primary': createContactsMockRelayAPI([
          { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
        ]),
        'company:primary': createContactsMockRelayAPI([]),
      },
      deliverFn: async () => true,
      dataDir: join(aliceDir, 'data'),
    } as A2ANetworkInternalOptions);
    track(aliceDir, alice);

    await alice.start();

    // getContacts merges across communities, returns only Bob (from home)
    const contacts = await alice.getContacts();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]!.username, 'bob');

    // Verify isolation: Bob is in home cache, not company cache
    const bobFromHome = (alice as any).caches.get('home')?.contacts.find((c: any) => c.username === 'bob');
    assert.ok(bobFromHome, 'Bob should be in home cache');
    assert.equal(bobFromHome.community, 'home');

    const bobFromCompany = (alice as any).caches.get('company')?.contacts.find((c: any) => c.username === 'bob');
    assert.equal(bobFromCompany, undefined, 'Bob should NOT be in company cache');
  });

  // Step 4: Failover on home community
  // Note: getContacts() in client.ts calls relay APIs directly (not through callApi()),
  // so failover is triggered through the CommunityRelayManager's callApi() path.
  // We use heartbeat as the failure trigger since it goes through callApi().
  it('step 4: failover on home emits community:status event', async () => {
    const aliceDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-fo-'));

    let primaryOk = true;
    const bobContact: RelayContact = { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false };

    const homePrimary = createMockRelayAPI({
      getContacts: async () => ({ ok: true, status: 200, data: [bobContact] }),
      heartbeat: async () => primaryOk ? { ok: true, status: 200 } : { ok: false, status: 500, error: 'down' },
    });
    const homeFailover = createContactsMockRelayAPI([bobContact]);

    const alice = new A2ANetwork({
      username: 'alice',
      privateKey: aliceKp.privateKeyDer,
      endpoint: 'https://alice.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.home.ai', failover: 'https://backup.home.ai' },
      ],
      relayAPIs: {
        'home:primary': homePrimary,
        'home:failover': homeFailover,
      },
      deliverFn: async () => true,
      dataDir: join(aliceDir, 'data'),
      failoverThreshold: 3,
    } as A2ANetworkInternalOptions);
    track(aliceDir, alice);

    await alice.start();

    const statusEvents: Array<{ community: string; status: string }> = [];
    alice.on('community:status', (e) => statusEvents.push(e));

    // Use communityManager.callApi to trigger failure tracking
    // First successful heartbeat (exit startup grace)
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));

    // Now fail 3 times via heartbeat
    primaryOk = false;
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));

    assert.equal(statusEvents.length, 1);
    assert.equal(statusEvents[0]!.community, 'home');
    assert.equal(statusEvents[0]!.status, 'failover');
  });

  // Step 5: Message delivery works after failover (P2P uses cached endpoints)
  it('step 5: message delivery works after failover', async () => {
    const aliceDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-post-fo-'));

    let primaryOk = true;
    let delivered = false;
    const bobContact: RelayContact = { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false };

    const homePrimary = createMockRelayAPI({
      getContacts: async () => ({ ok: true, status: 200, data: [bobContact] }),
      heartbeat: async () => primaryOk ? { ok: true, status: 200 } : { ok: false, status: 500, error: 'down' },
    });
    const homeFailover = createContactsMockRelayAPI([bobContact]);

    const alice = new A2ANetwork({
      username: 'alice',
      privateKey: aliceKp.privateKeyDer,
      endpoint: 'https://alice.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.home.ai', failover: 'https://backup.home.ai' },
      ],
      relayAPIs: {
        'home:primary': homePrimary,
        'home:failover': homeFailover,
      },
      deliverFn: async () => { delivered = true; return true; },
      dataDir: join(aliceDir, 'data'),
      failoverThreshold: 3,
    } as A2ANetworkInternalOptions);
    track(aliceDir, alice);

    await alice.start();

    // Populate cache via getContacts + exit grace via callApi
    await alice.getContacts();
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));

    // Trigger failover via heartbeat
    primaryOk = false;
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));

    // Send after failover — P2P delivery uses cached contact endpoint
    const result = await alice.send('bob', { text: 'Hello after failover!' });
    assert.equal(result.status, 'delivered');
    assert.equal(delivered, true);
  });

  // Step 6: getContacts after failover returns contacts from failover relay
  it('step 6: getContacts after failover fetches from failover relay', async () => {
    const aliceDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-fo-contacts-'));

    let primaryOk = true;
    const bobContact: RelayContact = { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false };

    const homePrimary = createMockRelayAPI({
      getContacts: async () => ({ ok: true, status: 200, data: [bobContact] }),
      heartbeat: async () => primaryOk ? { ok: true, status: 200 } : { ok: false, status: 500, error: 'down' },
    });
    const homeFailover = createContactsMockRelayAPI([bobContact]);

    const alice = new A2ANetwork({
      username: 'alice',
      privateKey: aliceKp.privateKeyDer,
      endpoint: 'https://alice.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.home.ai', failover: 'https://backup.home.ai' },
      ],
      relayAPIs: {
        'home:primary': homePrimary,
        'home:failover': homeFailover,
      },
      deliverFn: async () => true,
      dataDir: join(aliceDir, 'data'),
      failoverThreshold: 3,
    } as A2ANetworkInternalOptions);
    track(aliceDir, alice);

    await alice.start();

    // Exit grace via heartbeat callApi
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));

    // Trigger failover via heartbeat
    primaryOk = false;
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));

    // Now getContacts should come from failover (getActiveApi switches)
    const contacts = await alice.getContacts();
    assert.ok(contacts.length >= 1);
    const bob = contacts.find(c => c.username === 'bob');
    assert.ok(bob, 'Bob should be in contacts from failover');
  });

  // Step 7: Primary recovers — no auto-failback (sticky)
  it('step 7: primary recovers but agent stays on failover (sticky)', async () => {
    const aliceDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-sticky-'));

    let primaryOk = true;
    const bobContact: RelayContact = { agent: 'bob', publicKey: bobKp.publicKeyBase64, endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false };

    const homePrimary = createMockRelayAPI({
      getContacts: async () => ({ ok: true, status: 200, data: [bobContact] }),
      heartbeat: async () => primaryOk ? { ok: true, status: 200 } : { ok: false, status: 500, error: 'down' },
    });
    const homeFailover = createContactsMockRelayAPI([bobContact]);

    const alice = new A2ANetwork({
      username: 'alice',
      privateKey: aliceKp.privateKeyDer,
      endpoint: 'https://alice.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.home.ai', failover: 'https://backup.home.ai' },
      ],
      relayAPIs: {
        'home:primary': homePrimary,
        'home:failover': homeFailover,
      },
      deliverFn: async () => true,
      dataDir: join(aliceDir, 'data'),
      failoverThreshold: 3,
    } as A2ANetworkInternalOptions);
    track(aliceDir, alice);

    await alice.start();

    const statusEvents: Array<{ community: string; status: string }> = [];
    alice.on('community:status', (e) => statusEvents.push(e));

    // Exit grace + trigger failover via callApi
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    primaryOk = false;
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    await (alice as any).communityManager.callApi('home', (api: any) => api.heartbeat('https://alice.example.com/inbox'));
    assert.equal(statusEvents.length, 1);
    assert.equal(statusEvents[0]!.status, 'failover');

    // Primary recovers
    primaryOk = true;

    // But Alice stays on failover — getContacts still works through failover
    const contacts = await alice.getContacts();
    assert.ok(contacts.length >= 1);

    // No additional status events — stays on failover (sticky)
    assert.equal(statusEvents.length, 1);
  });
});
