/**
 * A2A Network SDK bridge — real implementation using kithkit-a2a-client.
 *
 * Wires the A2ANetwork relay client into the kithkit daemon so relay
 * fallback works when LAN delivery fails.
 */

import { createLogger } from '../../../core/logger.js';
import { readKeychain } from '../../../core/keychain.js';

const log = createLogger('network:sdk-bridge');

// ── Types ───────────────────────────────────────────────────

export interface NetworkClient {
  communities: Array<{ name: string; primary: string; failover?: string }>;
  send(to: string, payload: Record<string, unknown>): Promise<{
    status: 'delivered' | 'queued' | 'failed';
    messageId: string;
    error?: string;
  }>;
  sendToGroup(groupId: string, payload: Record<string, unknown>): Promise<{
    messageId: string;
    delivered: string[];
    queued: string[];
    failed: string[];
  }>;
  getGroups(): Promise<Array<{ id: string; name: string; [key: string]: unknown }>>;
  getContacts(): Promise<unknown[]>;
  requestContact(username: string): Promise<unknown>;
  getPendingRequests(): Promise<unknown[]>;
  acceptContact(username: string): Promise<void>;
  denyContact(username: string): Promise<void>;
  removeContact(username: string): Promise<void>;
  checkPresence(username: string): Promise<unknown>;
  createGroup(name: string, settings?: Record<string, unknown>): Promise<unknown>;
  getGroupInvitations(): Promise<unknown[]>;
  getGroupMembers(groupId: string): Promise<unknown[]>;
  inviteToGroup(groupId: string, agent: string, greeting?: string): Promise<void>;
  acceptGroupInvitation(groupId: string): Promise<void>;
  declineGroupInvitation(groupId: string): Promise<void>;
  leaveGroup(groupId: string): Promise<void>;
  transferGroupOwnership(groupId: string, newOwner: string): Promise<void>;
  removeFromGroup(groupId: string, member: string): Promise<void>;
  dissolveGroup(groupId: string): Promise<void>;
  checkBroadcasts(): Promise<unknown[]>;
}

// The real SDK client (lazily typed to avoid import issues in public repo)
let _sdkClient: NetworkClient | null = null;
let _rawClient: unknown = null; // The actual A2ANetwork instance for P2P handling

// ── Public API ──────────────────────────────────────────────

export function getNetworkClient(): NetworkClient | null {
  return _sdkClient;
}

export function getCommunityStatus(_name: string): Record<string, unknown> {
  if (!_sdkClient) return { connected: false };
  const community = _sdkClient.communities.find(c => c.name === _name);
  return community ? { connected: true, community: _name } : { connected: false };
}

export async function initNetworkSDK(config: Record<string, unknown>): Promise<boolean> {
  const networkConfig = config.network as {
    enabled?: boolean;
    communities?: Array<{ name: string; primary: string; failover?: string }>;
    endpoint?: string;
    heartbeat_interval?: number;
  } | undefined;

  if (!networkConfig?.enabled) {
    log.info('Network SDK disabled (network.enabled = false)');
    return false;
  }

  const agentConfig = config.agent as { name?: string } | undefined;
  const username = agentConfig?.name?.toLowerCase();
  if (!username) {
    log.error('Cannot init Network SDK — agent.name not set');
    return false;
  }

  const endpoint = networkConfig.endpoint;
  if (!endpoint) {
    log.error('Cannot init Network SDK — network.endpoint not set');
    return false;
  }

  const communities = networkConfig.communities;
  if (!communities?.length) {
    log.error('Cannot init Network SDK — no communities configured');
    return false;
  }

  // Load private key from Keychain (same service name as network:crypto)
  let privateKey: Buffer;
  try {
    const keyBase64 = await readKeychain('credential-cc4me-agent-key');
    if (!keyBase64) {
      log.error('Cannot init Network SDK — agent key not found in Keychain (credential-cc4me-agent-key)');
      return false;
    }
    privateKey = Buffer.from(keyBase64, 'base64');
  } catch (err) {
    log.error('Cannot init Network SDK — failed to load private key from Keychain', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  // Dynamic import of the SDK (installed via package.json file: dependency)
  let sdk: typeof import('kithkit-a2a-client');
  try {
    sdk = await import('kithkit-a2a-client');
  } catch (err) {
    log.error('Cannot init Network SDK — kithkit-a2a-client not installed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  try {
    const client = new sdk.A2ANetwork({
      username,
      privateKey,
      endpoint,
      communities: communities.map(c => ({
        name: c.name,
        primary: c.primary,
        failover: c.failover,
      })),
      dataDir: `${process.cwd()}/data/a2a-network`,
      heartbeatInterval: networkConfig.heartbeat_interval ?? 300000,
    });

    // Start the client (registers with relay, starts heartbeat)
    await client.start();

    _rawClient = client;
    _sdkClient = client as unknown as NetworkClient;

    log.info('Network SDK initialized', {
      username,
      communities: communities.map(c => c.name),
      endpoint,
    });
    return true;
  } catch (err) {
    log.error('Network SDK start failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function stopNetworkSDK(): Promise<void> {
  if (_rawClient) {
    try {
      await (_rawClient as { stop(): Promise<void> }).stop();
    } catch (err) {
      log.warn('Error stopping Network SDK', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  _sdkClient = null;
  _rawClient = null;
}

export async function handleIncomingP2P(envelope: unknown): Promise<void> {
  if (!_rawClient) {
    log.warn('P2P message received but Network SDK not initialized');
    return;
  }

  try {
    const env = envelope as { type?: string; groupId?: string };
    const client = _rawClient as {
      receiveMessage(env: unknown): unknown;
      receiveGroupMessage(env: unknown): Promise<unknown>;
      emit(event: string, data: unknown): boolean;
    };

    if (env.type === 'group' && env.groupId) {
      const msg = await client.receiveGroupMessage(envelope);
      if (msg) {
        client.emit('group-message', msg);
      }
    } else {
      const msg = client.receiveMessage(envelope);
      client.emit('message', msg);
    }
  } catch (err) {
    log.error('Failed to process incoming P2P envelope', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
