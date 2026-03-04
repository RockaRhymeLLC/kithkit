/**
 * SDK Bridge — integrates the KithKit A2A Network SDK into the kithkit daemon.
 *
 * Initializes the A2ANetwork client, wires SDK events to session bridge,
 * and exposes the network client for agent-comms (P2P fallback).
 *
 * kithkit-a2a-client is loaded dynamically. If not installed, daemon degrades
 * gracefully to LAN-only mode.
 */

import type {
  CC4MeNetwork, CommunityConfig, CommunityStatusEvent,
  Message, ContactRequest, Broadcast, WireEnvelope,
  GroupMessage, GroupInvitationEvent,
} from './sdk-types.js';
import type { AgentConfig, NetworkCommunity } from '../../config.js';
import { createLogger } from '../../../core/logger.js';
import { commsSessionExists } from '../../../core/session-bridge.js';
import { sendMessage } from '../../../agents/message-router.js';
import { readKeychain } from '../../../core/keychain.js';
import { loadKeyFromKeychain } from './crypto.js';
import { logCommsEntry, getDisplayName } from '../agent-comms.js';

const log = createLogger('network:sdk');

let _network: CC4MeNetwork | null = null;
let _config: AgentConfig | null = null;

export function getNetworkClient(): CC4MeNetwork | null {
  return _network;
}

/**
 * Initialize the KithKit A2A Network SDK.
 * Returns true if initialization succeeded, false if degraded to LAN-only.
 */
export async function initNetworkSDK(config: Record<string, unknown>): Promise<boolean> {
  _config = config as unknown as AgentConfig;
  const networkConfig = _config.network;

  if (!networkConfig?.enabled) {
    log.info('Network SDK disabled');
    return false;
  }

  if (!networkConfig.communities?.length) {
    log.warn('Network SDK: no communities configured');
    return false;
  }

  if (!networkConfig.endpoint) {
    log.warn('Network SDK: no endpoint configured — P2P messaging requires a public endpoint');
    return false;
  }

  // Load private key from Keychain (async in v2)
  const privateKeyBase64 = await loadKeyFromKeychain();
  if (!privateKeyBase64) {
    log.warn('Network SDK: no agent key in Keychain — run registration first');
    return false;
  }

  try {
    // Dynamic import — kithkit-a2a-client is optional
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let CC4MeNetworkClass: any;
    try {
      // @ts-ignore — kithkit-a2a-client is a local dev module, resolved at runtime
      const sdk = await import('kithkit-a2a-client');
      CC4MeNetworkClass = sdk.A2ANetwork;
    } catch {
      log.warn('kithkit-a2a-client package not installed — P2P messaging unavailable. Install with: npm install kithkit-a2a-client');
      return false;
    }

    const privateKeyBuffer = Buffer.from(privateKeyBase64, 'base64');
    const agentName = _config.agent.name.toLowerCase();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions: any = {
      username: agentName,
      privateKey: privateKeyBuffer,
      endpoint: networkConfig.endpoint,
      dataDir: '.claude/state/network-cache',
      heartbeatInterval: networkConfig.heartbeat_interval ?? 300_000,
    };

    sdkOptions.communities = await buildCommunityConfigs(networkConfig.communities, privateKeyBuffer);
    sdkOptions.failoverThreshold = 3;

    log.info('Network SDK: multi-community mode', {
      communities: networkConfig.communities.map((c: NetworkCommunity) => c.name),
    });

    _network = new CC4MeNetworkClass(sdkOptions);

    wireMessageEvent();
    wireGroupMessageEvent();
    wireGroupInvitationEvent();
    wireContactRequestEvent(networkConfig.auto_approve_contacts ?? false);
    wireBroadcastEvent();
    wireCommunityStatusEvent();

    await _network!.start();

    log.info('Network SDK initialized', {
      communities: networkConfig.communities.map((c: NetworkCommunity) => c.name),
      endpoint: networkConfig.endpoint,
      agent: agentName,
    });

    return true;
  } catch (err) {
    log.error('Network SDK initialization failed — degrading to LAN-only', {
      error: err instanceof Error ? err.message : String(err),
    });
    _network = null;
    return false;
  }
}

async function buildCommunityConfigs(
  yamlCommunities: NetworkCommunity[],
  _defaultKey: Buffer,
): Promise<CommunityConfig[]> {
  const configs: CommunityConfig[] = [];

  for (const c of yamlCommunities) {
    const sdkCommunity: CommunityConfig = {
      name: c.name,
      primary: c.primary,
    };

    if (c.failover) {
      sdkCommunity.failover = c.failover;
    }

    // Per-community keypair from Keychain (async)
    const keypairName = (c as unknown as Record<string, unknown>).keypair as string | undefined;
    if (keypairName) {
      const keyBase64 = await readKeychain(keypairName);
      if (keyBase64) {
        sdkCommunity.privateKey = Buffer.from(keyBase64, 'base64');
        log.info(`Loaded community-specific keypair for '${c.name}' from Keychain (${keypairName})`);
      } else {
        log.warn(`Community '${c.name}': keypair credential '${keypairName}' not found — using default key`);
      }
    }

    configs.push(sdkCommunity);
  }

  return configs;
}

export function getCommunityStatus(communityName: string): { status: 'active' | 'failover' | 'offline' | 'unknown'; activeRelay?: string } {
  if (!_network) return { status: 'unknown' };

  const communities = _network.communities;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const community = communities.find((c: any) => c.name === communityName);
  if (!community) return { status: 'unknown' };

  const manager = _network.getCommunityManager();
  const activeType = manager.getActiveRelayType(communityName);
  const activeRelay = activeType === 'failover' && community.failover
    ? community.failover
    : community.primary;
  const status = activeType === 'failover' ? 'failover' : 'active';

  return { status, activeRelay };
}

/**
 * Process an incoming P2P message envelope.
 * Called from the /agent/p2p HTTP endpoint.
 */
export async function handleIncomingP2P(envelope: WireEnvelope): Promise<boolean> {
  if (!_network) {
    log.warn('Received P2P message but SDK not initialized');
    return false;
  }

  try {
    if (envelope.type === 'group') {
      const msg = await _network.receiveGroupMessage(envelope);
      if (!msg) {
        log.info('Group message deduplicated', { messageId: envelope.messageId });
      }
      return true;
    } else {
      _network.receiveMessage(envelope);
      return true;
    }
  } catch (err) {
    log.warn('Failed to process incoming P2P message', {
      error: err instanceof Error ? err.message : String(err),
      sender: envelope.sender,
      type: envelope.type,
    });
    return false;
  }
}

export async function stopNetworkSDK(): Promise<void> {
  if (_network) {
    await _network.stop();
    _network = null;
    log.info('Network SDK stopped');
  }
}

// ── Event Wiring ─────────────────────────────────────────────

function getAgentName(): string {
  return _config?.agent?.name?.toLowerCase() ?? 'unknown';
}

function wireMessageEvent(): void {
  if (!_network) return;

  _network.on('message', (msg: Message) => {
    // Status pings are liveness checks only — do not store or inject
    if (msg.payload?.type === 'status') {
      log.debug(`Status ping from ${msg.sender} via network — acknowledged, not stored`);
      return;
    }

    const displayName = getDisplayName(msg.sender);
    const text = msg.payload?.text ?? JSON.stringify(msg.payload);
    const verified = msg.verified ? '' : ' [UNVERIFIED]';
    const formatted = `[Network] ${displayName}${verified}: ${text}`;

    // Persist inbound message to DB so content is never lost
    sendMessage({
      from: `network:${msg.sender}`,
      to: 'comms',
      type: 'text',
      body: formatted,
      metadata: { source: 'a2a-network', sender: msg.sender, messageId: msg.messageId, verified: msg.verified },
      direct: true,
    });

    if (!commsSessionExists()) {
      log.info('No comms session — network message persisted to DB but not injected', {
        from: msg.sender,
        messageId: msg.messageId,
      });
    }

    logCommsEntry({
      ts: new Date().toISOString(),
      direction: 'in',
      from: msg.sender,
      to: getAgentName(),
      type: 'text',
      text: String(text),
      messageId: msg.messageId,
    });
  });
}

function wireGroupMessageEvent(): void {
  if (!_network) return;

  _network.on('group-message', (msg: GroupMessage) => {
    const displayName = getDisplayName(msg.sender);
    const text = msg.payload?.text ?? JSON.stringify(msg.payload);
    const verified = msg.verified ? '' : ' [UNVERIFIED]';
    const groupTag = msg.groupId.slice(0, 8);
    const formatted = `[Group:${groupTag}] ${displayName}${verified}: ${text}`;

    sendMessage({
      from: `network:${msg.sender}`,
      to: 'comms',
      type: 'text',
      body: formatted,
      metadata: { source: 'a2a-network', sender: msg.sender, messageId: msg.messageId, groupId: msg.groupId, verified: msg.verified },
      direct: true,
    });

    if (!commsSessionExists()) {
      log.info('No comms session — group message persisted to DB but not injected', {
        from: msg.sender,
        groupId: msg.groupId,
        messageId: msg.messageId,
      });
    }

    logCommsEntry({
      ts: new Date().toISOString(),
      direction: 'in',
      from: msg.sender,
      to: getAgentName(),
      type: 'group-message',
      text: String(text),
      messageId: msg.messageId,
      groupId: msg.groupId,
    });
  });
}

function wireGroupInvitationEvent(): void {
  if (!_network) return;

  _network.on('group-invitation', (inv: GroupInvitationEvent) => {
    const displayName = getDisplayName(inv.invitedBy);
    const greeting = inv.greeting ? `: "${inv.greeting}"` : '';
    const formatted = `[Network] Group invitation: "${inv.groupName}" from ${displayName}${greeting}. Accept with: network.acceptGroupInvitation('${inv.groupId}')`;

    sendMessage({
      from: `network:${inv.invitedBy}`,
      to: 'comms',
      type: 'text',
      body: formatted,
      metadata: { source: 'a2a-network', type: 'group-invitation', groupId: inv.groupId, groupName: inv.groupName, invitedBy: inv.invitedBy },
      direct: true,
    });

    if (!commsSessionExists()) {
      log.info('No comms session — group invitation persisted to DB', {
        groupId: inv.groupId,
        groupName: inv.groupName,
        invitedBy: inv.invitedBy,
      });
    }
  });
}

function wireContactRequestEvent(autoApprove: boolean): void {
  if (!_network) return;
  const network = _network;

  _network.on('contact-request', async (req: ContactRequest) => {
    const displayName = getDisplayName(req.from);

    if (autoApprove) {
      try {
        await network.acceptContact(req.from);
        log.info(`Auto-approved contact request from ${req.from}`);
        const formatted = `[Network] Auto-approved contact request from ${displayName}`;
        sendMessage({
          from: `network:${req.from}`,
          to: 'comms',
          type: 'text',
          body: formatted,
          metadata: { source: 'a2a-network', type: 'contact-request', autoApproved: true, from: req.from },
          direct: true,
        });
      } catch (err) {
        log.error('Failed to auto-approve contact', {
          from: req.from,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const emailInfo = req.requesterEmail ? ` (${req.requesterEmail})` : '';
    const prompt = `[Network] Contact request from ${displayName}${emailInfo}. Accept with: network.acceptContact('${req.from}')`;

    sendMessage({
      from: `network:${req.from}`,
      to: 'comms',
      type: 'text',
      body: prompt,
      metadata: { source: 'a2a-network', type: 'contact-request', from: req.from, email: req.requesterEmail },
      direct: true,
    });

    if (!commsSessionExists()) {
      log.info('No comms session — contact request persisted to DB', { from: req.from });
    }
  });
}

function wireBroadcastEvent(): void {
  if (!_network) return;

  _network.on('broadcast', (broadcast: Broadcast) => {
    const displayName = getDisplayName(broadcast.sender);
    const summary = broadcast.payload?.message ?? broadcast.type;
    const formatted = `[Network Broadcast] ${displayName}: [${broadcast.type}] ${summary}`;

    sendMessage({
      from: `network:${broadcast.sender}`,
      to: 'comms',
      type: 'text',
      body: formatted,
      metadata: { source: 'a2a-network', type: 'broadcast', broadcastType: broadcast.type, sender: broadcast.sender },
      direct: true,
    });

    log.info('Received broadcast', {
      type: broadcast.type,
      sender: broadcast.sender,
    });
  });
}

function wireCommunityStatusEvent(): void {
  if (!_network) return;

  _network.on('community:status', (event: CommunityStatusEvent) => {
    log.warn(`Community status change: ${event.community} -> ${event.status}`, {
      community: event.community,
      status: event.status,
    });

    const formatted = `[Network] Community '${event.community}' is now ${event.status}`;
    sendMessage({
      from: 'network:system',
      to: 'comms',
      type: 'status',
      body: formatted,
      metadata: { source: 'a2a-network', type: 'community-status', community: event.community, status: event.status },
      direct: true,
    });
  });
}
