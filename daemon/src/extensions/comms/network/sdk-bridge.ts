/**
 * SDK Bridge — integrates the CC4Me Network SDK into the kithkit daemon.
 *
 * Initializes the CC4MeNetwork client, wires SDK events to session bridge,
 * and exposes the network client for agent-comms (P2P fallback).
 *
 * cc4me-network is loaded dynamically. If not installed, daemon degrades
 * gracefully to LAN-only mode.
 */

import type {
  CC4MeNetworkClient, CommunityConfig, CommunityStatusEvent,
  Message, ContactRequest, Broadcast, WireEnvelope,
  GroupMessage, GroupInvitationEvent,
} from './sdk-types.js';
import type { BmoConfig, NetworkCommunity } from '../../config.js';
import { createLogger } from '../../../core/logger.js';
import { sessionExists, injectText } from '../../../core/session-bridge.js';
import { readKeychain } from '../../../core/keychain.js';
import { loadKeyFromKeychain } from './crypto.js';
import { logCommsEntry, getDisplayName } from '../agent-comms.js';

const log = createLogger('network:sdk');

let _network: CC4MeNetworkClient | null = null;
let _config: BmoConfig | null = null;

export function getNetworkClient(): CC4MeNetworkClient | null {
  return _network;
}

/**
 * Initialize the CC4Me Network SDK.
 * Returns true if initialization succeeded, false if degraded to LAN-only.
 */
export async function initNetworkSDK(config: BmoConfig): Promise<boolean> {
  _config = config;
  const networkConfig = config.network;

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
    // Dynamic import — cc4me-network is optional
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let CC4MeNetworkClass: any;
    try {
      // @ts-expect-error — cc4me-network is an optional dependency, loaded dynamically
      const sdk = await import('cc4me-network');
      CC4MeNetworkClass = sdk.CC4MeNetwork;
    } catch {
      log.warn('cc4me-network package not installed — P2P messaging unavailable. Install with: npm install cc4me-network');
      return false;
    }

    const privateKeyBuffer = Buffer.from(privateKeyBase64, 'base64');
    const agentName = config.agent.name.toLowerCase();

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
      communities: networkConfig.communities.map(c => c.name),
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
      communities: networkConfig.communities.map(c => c.name),
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
  const community = communities.find(c => c.name === communityName);
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
    const displayName = getDisplayName(msg.sender, _config);
    const text = msg.payload?.text ?? JSON.stringify(msg.payload);
    const verified = msg.verified ? '' : ' [UNVERIFIED]';
    const formatted = `[Network] ${displayName}${verified}: ${text}`;

    if (sessionExists()) {
      injectText(formatted);
    } else {
      log.info('No session — network message logged but not injected', {
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
    const displayName = getDisplayName(msg.sender, _config);
    const text = msg.payload?.text ?? JSON.stringify(msg.payload);
    const verified = msg.verified ? '' : ' [UNVERIFIED]';
    const groupTag = msg.groupId.slice(0, 8);
    const formatted = `[Group:${groupTag}] ${displayName}${verified}: ${text}`;

    if (sessionExists()) {
      injectText(formatted);
    } else {
      log.info('No session — group message logged but not injected', {
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
    const displayName = getDisplayName(inv.invitedBy, _config);
    const greeting = inv.greeting ? `: "${inv.greeting}"` : '';
    const formatted = `[Network] Group invitation: "${inv.groupName}" from ${displayName}${greeting}. Accept with: network.acceptGroupInvitation('${inv.groupId}')`;

    if (sessionExists()) {
      injectText(formatted);
    } else {
      log.info('No session — group invitation logged', {
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
    const displayName = getDisplayName(req.from, _config);

    if (autoApprove) {
      try {
        await network.acceptContact(req.from);
        log.info(`Auto-approved contact request from ${req.from}`);
        if (sessionExists()) {
          injectText(`[Network] Auto-approved contact request from ${displayName}`);
        }
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

    if (sessionExists()) {
      injectText(prompt);
    } else {
      log.info('No session — contact request logged', { from: req.from });
    }
  });
}

function wireBroadcastEvent(): void {
  if (!_network) return;

  _network.on('broadcast', (broadcast: Broadcast) => {
    const displayName = getDisplayName(broadcast.sender, _config);
    const summary = broadcast.payload?.message ?? broadcast.type;
    const formatted = `[Network Broadcast] ${displayName}: [${broadcast.type}] ${summary}`;

    if (sessionExists()) {
      injectText(formatted);
    }

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

    if (sessionExists()) {
      injectText(`[Network] Community '${event.community}' is now ${event.status}`);
    }
  });
}
