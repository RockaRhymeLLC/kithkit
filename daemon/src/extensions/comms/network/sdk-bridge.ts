/**
 * A2A Network SDK bridge — stub for kithkit core.
 *
 * Agent-specific repos provide the real implementation.
 * This stub exists so the comms extension compiles in the public repo.
 */

import { createLogger } from '../../../core/logger.js';

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

let _client: NetworkClient | null = null;

// ── Public API ──────────────────────────────────────────────

export function getNetworkClient(): NetworkClient | null {
  return _client;
}

export function getCommunityStatus(_name: string): Record<string, unknown> {
  return { connected: false };
}

export async function initNetworkSDK(_config: Record<string, unknown>): Promise<boolean> {
  log.info('Network SDK stub — no real implementation in kithkit core');
  return false;
}

export async function stopNetworkSDK(): Promise<void> {
  _client = null;
}

export async function handleIncomingP2P(_envelope: unknown): Promise<void> {
  log.warn('P2P message received but no SDK implementation available');
}
