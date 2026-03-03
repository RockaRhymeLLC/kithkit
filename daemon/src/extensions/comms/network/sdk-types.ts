/**
 * Local type definitions for the kithkit-a2a-client SDK.
 *
 * These mirror the SDK's exported types so the daemon compiles without
 * requiring kithkit-a2a-client to be installed. The SDK is loaded dynamically
 * at runtime by sdk-bridge.ts.
 */

/**
 * Community relay configuration — one entry per relay community.
 */
export interface CommunityConfig {
  name: string;
  primary: string;
  failover?: string;
  privateKey?: Buffer;
}

export interface CommunityStatusEvent {
  community: string;
  status: 'active' | 'failover' | 'offline';
}

export interface A2ANetworkOptions {
  relayUrl?: string;
  username: string;
  privateKey: Buffer;
  endpoint: string;
  dataDir?: string;
  heartbeatInterval?: number;
  retryQueueMax?: number;
  communities?: CommunityConfig[];
  failoverThreshold?: number;
}

export interface Message {
  sender: string;
  messageId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  verified: boolean;
}

export interface ContactRequest {
  from: string;
  requesterEmail: string;
  publicKey: string;
  ownerEmail: string;
}

export interface Broadcast {
  type: string;
  payload: Record<string, unknown>;
  sender: string;
  verified: boolean;
}

export interface GroupMessage {
  groupId: string;
  sender: string;
  messageId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  verified: boolean;
}

export interface GroupInvitationEvent {
  groupId: string;
  groupName: string;
  invitedBy: string;
  greeting: string | null;
}

export interface WireEnvelope {
  version: string;
  type: 'direct' | 'group' | 'broadcast' | 'contact-request' | 'contact-response' | 'revocation' | 'receipt';
  messageId: string;
  sender: string;
  recipient: string;
  timestamp: string;
  groupId?: string;
  payload: {
    ciphertext?: string;
    nonce?: string;
    [key: string]: unknown;
  };
  signature: string;
}

export interface SendResult {
  status: 'delivered' | 'queued' | 'failed';
  messageId: string;
  error?: string;
}

export interface GroupSendResult {
  messageId: string;
  delivered: string[];
  queued: string[];
  failed: string[];
}

export interface Contact {
  username: string;
  publicKey: string;
  endpoint: string;
  addedAt: string;
  online: boolean;
  lastSeen: string | null;
  keyUpdatedAt: string | null;
  recoveryInProgress: boolean;
}

export interface ContactActionResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface PresenceInfo {
  agent: string;
  online: boolean;
  endpoint?: string;
  lastSeen: string;
}

export interface RelayGroup {
  groupId: string;
  name: string;
  owner: string;
  status: string;
  role: string;
  settings?: Record<string, unknown>;
  memberCount?: number;
  createdAt: string;
}

export interface RelayGroupMember {
  agent: string;
  role: string;
  joinedAt: string;
}

export interface RelayGroupInvitation {
  groupId: string;
  groupName: string;
  invitedBy: string;
  greeting: string | null;
  createdAt: string;
}

export interface DeliveryAttempt {
  timestamp: string;
  presenceCheck?: boolean;
  endpoint?: string;
  httpStatus?: number;
  durationMs?: number;
  error?: string;
}

export interface DeliveryReport {
  messageId: string;
  attempts: DeliveryAttempt[];
  finalStatus: string;
}

export interface KeyRotationCommunityResult {
  community: string;
  success: boolean;
  error?: string;
}

export interface KeyRotationResult {
  results: KeyRotationCommunityResult[];
}

export interface A2ANetworkClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'message', handler: (msg: Message) => void): void;
  on(event: 'group-message', handler: (msg: GroupMessage) => void): void;
  on(event: 'group-invitation', handler: (inv: GroupInvitationEvent) => void): void;
  on(event: 'contact-request', handler: (req: ContactRequest) => void): void;
  on(event: 'broadcast', handler: (broadcast: Broadcast) => void): void;
  on(event: 'community:status', handler: (event: CommunityStatusEvent) => void): void;
  receiveMessage(envelope: WireEnvelope): void;
  receiveGroupMessage(envelope: WireEnvelope): Promise<GroupMessage | null>;
  acceptContact(username: string): Promise<void>;
  rotateKey(newPublicKey: string, options?: { communities?: string[] }): Promise<KeyRotationResult>;
  send(to: string, payload: Record<string, unknown>): Promise<SendResult>;
  sendToGroup(groupId: string, payload: Record<string, unknown>): Promise<GroupSendResult>;
  readonly communities: Array<{ name: string; primary: string; failover?: string }>;
  getCommunityManager(): {
    getActiveRelayType(communityName: string): 'primary' | 'failover';
    getFailureCount(communityName: string): number;
  };

  // Contact management
  requestContact(nameOrQualified: string): Promise<ContactActionResult>;
  getPendingRequests(): Promise<ContactRequest[]>;
  denyContact(username: string): Promise<void>;
  removeContact(username: string): Promise<void>;
  getContacts(): Promise<Contact[]>;

  // Presence
  checkPresence(username: string): Promise<PresenceInfo>;

  // Groups
  createGroup(name: string, settings?: Record<string, unknown>): Promise<RelayGroup>;
  inviteToGroup(groupId: string, agent: string, greeting?: string): Promise<void>;
  acceptGroupInvitation(groupId: string): Promise<void>;
  declineGroupInvitation(groupId: string): Promise<void>;
  leaveGroup(groupId: string): Promise<void>;
  removeFromGroup(groupId: string, agent: string): Promise<void>;
  dissolveGroup(groupId: string): Promise<void>;
  getGroups(): Promise<RelayGroup[]>;
  getGroupMembers(groupId: string): Promise<RelayGroupMember[]>;
  getGroupInvitations(): Promise<RelayGroupInvitation[]>;
  transferGroupOwnership(groupId: string, newOwner: string): Promise<void>;

  // Delivery tracking
  getDeliveryReport(messageId: string): DeliveryReport | undefined;

  // Broadcasts
  checkBroadcasts(): Promise<Broadcast[]>;
}
