/**
 * KithKit A2A Agent — P2P encrypted messaging SDK for AI agents.
 *
 * @example
 * ```typescript
 * import { A2ANetwork } from 'kithkit-a2a-client';
 *
 * const network = new A2ANetwork({
 *   relayUrl: 'https://relay.bmobot.ai',
 *   username: 'my-agent',
 *   privateKey: myEd25519PrivateKey,
 *   endpoint: 'https://my-agent.example.com/network/inbox',
 * });
 *
 * await network.start();
 * await network.send('friend', { text: 'Hello!' });
 * ```
 *
 * @packageDocumentation
 */

export { A2ANetwork } from './client.js';
export type { DeliverFn, A2ANetworkEvents, A2ANetworkInternalOptions, GroupInvitationEvent, GroupMemberChangeEvent } from './client.js';
export type {
  A2ANetworkOptions,
  CommunityConfig,
  CommunityStatusEvent,
  SendResult,
  GroupSendResult,
  GroupMessage,
  Message,
  ContactRequest,
  ContactActionResult,
  Broadcast,
  DeliveryStatus,
  DeliveryReport,
  Contact,
  WireEnvelope,
  KeyRotationResult,
  KeyRotationCommunityResult,
} from './types.js';

// Community management
export { CommunityRelayManager, parseQualifiedName } from './community-manager.js';
export type { CommunityState, ParsedName } from './community-manager.js';

// Relay API (for custom implementations / testing)
export { HttpRelayAPI } from './relay-api.js';
export type {
  IRelayAPI,
  RelayResponse,
  RelayContact,
  RelayPendingRequest,
  RelayBroadcast,
  RelayGroup,
  RelayGroupMember,
  RelayGroupInvitation,
  RelayGroupChange,
} from './relay-api.js';
