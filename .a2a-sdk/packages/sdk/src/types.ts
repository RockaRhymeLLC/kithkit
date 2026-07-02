/**
 * SDK type definitions.
 */

/**
 * Community relay configuration — one entry per relay community.
 */
export interface CommunityConfig {
  /** Human-readable community label (alphanumeric + hyphen only) */
  name: string;
  /** Primary relay URL */
  primary: string;
  /** Optional failover relay URL */
  failover?: string;
  /** Community-specific Ed25519 private key (PKCS8 DER). Defaults to top-level privateKey. */
  privateKey?: Buffer;
}

/**
 * Emitted on community relay status changes (active → failover → offline).
 */
export interface CommunityStatusEvent {
  community: string;
  status: 'active' | 'failover' | 'offline';
}

export interface A2ANetworkOptions {
  /** Relay server URL (single-relay mode, mutually exclusive with communities) */
  relayUrl?: string;
  /** Agent's username on the network */
  username: string;
  /** Ed25519 private key (PKCS8 DER format) — default key, communities can override */
  privateKey: Buffer;
  /** Agent's reachable HTTPS endpoint for receiving messages */
  endpoint: string;
  /** Directory for persisting local cache (contacts, keys) */
  dataDir?: string;
  /** Presence heartbeat interval in ms (default: 300000 = 5 min) */
  heartbeatInterval?: number;
  /** Max messages in retry queue (default: 100) */
  retryQueueMax?: number;
  /** Multi-community config (mutually exclusive with relayUrl) */
  communities?: CommunityConfig[];
  /** Consecutive failures before failover (default: 3) */
  failoverThreshold?: number;
}

export interface SendResult {
  status: 'delivered' | 'queued' | 'failed';
  messageId: string;
  error?: string;
}

export interface Message {
  sender: string;
  messageId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  verified: boolean;
  /**
   * ISO timestamp set by the SDK when the message is emitted to listeners.
   * Undefined on duplicate messageIds (dedup'd before emit).
   * Mirrors the daemon's injected_at DB column for delivery-integrity semantics.
   */
  injectedAt?: string;
}

export interface ContactRequest {
  from: string;
  requesterEmail: string;
  publicKey: string;
}

export interface Broadcast {
  type: string;
  payload: Record<string, unknown>;
  sender: string;
  verified: boolean;
}

export interface DeliveryStatus {
  messageId: string;
  status: 'pending' | 'sending' | 'delivered' | 'expired' | 'failed';
  attempts: number;
}

export interface DeliveryReport {
  messageId: string;
  attempts: Array<{
    timestamp: string;
    presenceCheck: boolean;
    endpoint: string;
    httpStatus?: number;
    error?: string;
    durationMs: number;
  }>;
  finalStatus: 'delivered' | 'expired' | 'failed';
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

export interface GroupMessage {
  groupId: string;
  sender: string;
  messageId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  verified: boolean;
  /**
   * ISO timestamp set by the SDK when the message is emitted to listeners.
   * Mirrors the daemon's injected_at DB column for delivery-integrity semantics.
   */
  injectedAt?: string;
}

/**
 * Delivery-integrity hook — called with the decoded, verified message BEFORE
 * the 'message' or 'group-message' event is emitted to SDK consumers.
 *
 * Mirrors the daemon's persist-on-receive seam (sendMessage call in wireMessageEvent /
 * wireGroupMessageEvent, daemon/src/extensions/comms/network/sdk-bridge.ts).
 *
 * Contract: the hook MUST persist the message durably before returning. If it
 * throws, the SDK dead-letters the message (does NOT emit the event), so the
 * caller can recover without data loss.
 *
 * Idempotency: the hook is never called twice for the same messageId — the SDK's
 * dedup layer (seenMessageIds / seenGroupMessageIds) filters duplicates before
 * the hook fires.
 */
export type ReceivePersistFn = (msg: Message | GroupMessage) => Promise<void>;

/**
 * Dead-letter entry — populated when persistFn throws.
 * Message was received and verified but NOT emitted to SDK consumers.
 * Retrieve via A2ANetwork.getDeadLetterQueue(); retry or alert as appropriate.
 */
export interface DeadLetterEntry {
  messageId: string;
  msg: Message | GroupMessage;
  error: string;
  receivedAt: string;
}

export interface ContactActionResult {
  ok: true;
  status: number;
}

export interface GroupSendResult {
  messageId: string;
  delivered: string[];
  queued: string[];
  failed: string[];
}

/** Per-community result from a multi-community key rotation. */
export interface KeyRotationCommunityResult {
  community: string;
  success: boolean;
  error?: string;
}

/** Result from rotateKey() — includes per-community breakdown. */
export interface KeyRotationResult {
  results: KeyRotationCommunityResult[];
}

/**
 * Wire format envelope — every P2P message uses this structure.
 */
export interface WireEnvelope {
  version: string;
  type: 'direct' | 'group' | 'broadcast' | 'contact-request' | 'contact-response' | 'revocation' | 'receipt';
  messageId: string;
  sender: string;
  recipient: string;
  timestamp: string;
  /** Group ID — required for type='group', must not be present for type='direct'. */
  groupId?: string;
  payload: {
    ciphertext?: string;
    nonce?: string;
    [key: string]: unknown;
  };
  signature: string;
}
