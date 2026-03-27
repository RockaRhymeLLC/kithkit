/**
 * Agent Access Control — 5-tier file-backed sender classification.
 *
 * Extends the framework's 3-tier access control (safe/unknown/blocked)
 * with agent 'approved' and 'denied' tiers, plus channel-aware classification,
 * expiry-aware approval checks, and file-backed persistent state.
 *
 * Classification tiers (checked in order):
 *   1. blocked  → silently drop
 *   2. safe     → full access (from kithkit.config.yaml channels.telegram.allowed_users)
 *   3. approved → inject with [3rdParty] tag (from 3rd-party-senders.json)
 *   4. denied   → re-trigger approval flow
 *   5. unknown  → hold, notify primary, wait for approval
 */

import fs from 'node:fs';
import path from 'node:path';
import { registerTier } from '../core/access-control.js';
import { getProjectDir } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('agent-access-control');

// ── Types ───────────────────────────────────────────────────

export type AgentSenderTier = 'blocked' | 'safe' | 'approved' | 'denied' | 'unknown';

export interface ApprovedSender {
  id: string;
  channel: string;
  name: string;
  type: 'human' | 'agent';
  approved_date: string;
  approved_by: string;
  expires: string | null;
  notes: string;
}

export interface DeniedSender {
  id: string;
  channel: string;
  name: string;
  denied_date: string;
  denial_count: number;
  reason: string;
}

export interface BlockedSender {
  id: string;
  channel: string;
  name: string;
  blocked_date: string;
  blocked_by: 'agent' | 'primary';
  reason: string;
}

export interface PendingSender {
  id: string;
  channel: string;
  name: string;
  requested_date: string;
  message: string;
}

export interface ThirdPartySendersState {
  approved: ApprovedSender[];
  denied: DeniedSender[];
  blocked: BlockedSender[];
  pending: PendingSender[];
}

// ── State file I/O ──────────────────────────────────────────

function getStateFilePath(): string {
  return path.join(getProjectDir(), '.claude', 'state', '3rd-party-senders.json');
}

/**
 * Read state fresh from disk every time (no stale cache).
 */
export function readState(): ThirdPartySendersState {
  try {
    const raw = fs.readFileSync(getStateFilePath(), 'utf8');
    return JSON.parse(raw) as ThirdPartySendersState;
  } catch {
    return { approved: [], denied: [], blocked: [], pending: [] };
  }
}

function writeState(state: ThirdPartySendersState): void {
  const filePath = getStateFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ── Channel-aware classification ────────────────────────────

/**
 * Classify a sender into one of the five BMO tiers.
 * This is the full channel-aware classifier — used internally and
 * also registered with the framework via registerTier().
 */
export function classifyAgentSender(id: string, channel: string): AgentSenderTier {
  const state = readState();

  // 1. Blocked — check first (highest priority)
  if (state.blocked.some(s => s.id === id && s.channel === channel)) {
    return 'blocked';
  }

  // 2. Approved 3rd party (with expiry check)
  const approved = state.approved.find(s => s.id === id && s.channel === channel);
  if (approved) {
    if (approved.expires && new Date(approved.expires) < new Date()) {
      return 'unknown'; // expired — triggers re-approval
    }
    return 'approved';
  }

  // 4. Denied (recently)
  if (state.denied.some(s => s.id === id && s.channel === channel)) {
    return 'denied';
  }

  // 5. Unknown
  return 'unknown';
}

// ── CRUD operations ─────────────────────────────────────────

export function addApproved(sender: Omit<ApprovedSender, 'approved_date'>): void {
  const state = readState();
  state.denied = state.denied.filter(s => !(s.id === sender.id && s.channel === sender.channel));
  state.pending = state.pending.filter(s => !(s.id === sender.id && s.channel === sender.channel));
  state.approved = state.approved.filter(s => !(s.id === sender.id && s.channel === sender.channel));
  state.approved.push({ ...sender, approved_date: new Date().toISOString() });
  writeState(state);
  log.info(`Added approved sender: ${sender.name} (${sender.id}) on ${sender.channel}`);
}

export function addDenied(id: string, channel: string, name: string, reason: string): void {
  const state = readState();
  state.pending = state.pending.filter(s => !(s.id === id && s.channel === channel));
  const existing = state.denied.find(s => s.id === id && s.channel === channel);
  if (existing) {
    existing.denial_count += 1;
    existing.denied_date = new Date().toISOString();
    existing.reason = reason;
  } else {
    state.denied.push({ id, channel, name, denied_date: new Date().toISOString(), denial_count: 1, reason });
  }
  writeState(state);
  log.info(`Denied sender: ${name} (${id}) on ${channel} — reason: ${reason}`);
}

export function addBlocked(id: string, channel: string, name: string, blockedBy: 'agent' | 'primary', reason: string): void {
  const state = readState();
  state.denied = state.denied.filter(s => !(s.id === id && s.channel === channel));
  state.pending = state.pending.filter(s => !(s.id === id && s.channel === channel));
  state.approved = state.approved.filter(s => !(s.id === id && s.channel === channel));
  if (!state.blocked.some(s => s.id === id && s.channel === channel)) {
    state.blocked.push({ id, channel, name, blocked_date: new Date().toISOString(), blocked_by: blockedBy, reason });
  }
  writeState(state);
  log.info(`Blocked sender: ${name} (${id}) on ${channel} — by: ${blockedBy}, reason: ${reason}`);
}

export function addPending(id: string, channel: string, name: string, message: string): void {
  const state = readState();
  if (state.pending.some(s => s.id === id && s.channel === channel)) return;
  state.pending.push({ id, channel, name, requested_date: new Date().toISOString(), message });
  writeState(state);
  log.info(`Added pending sender: ${name} (${id}) on ${channel}`);
}

export function removeSender(id: string, channel: string): void {
  const state = readState();
  state.approved = state.approved.filter(s => !(s.id === id && s.channel === channel));
  state.denied = state.denied.filter(s => !(s.id === id && s.channel === channel));
  state.blocked = state.blocked.filter(s => !(s.id === id && s.channel === channel));
  state.pending = state.pending.filter(s => !(s.id === id && s.channel === channel));
  writeState(state);
  log.info(`Removed sender ${id} from all lists on ${channel}`);
}

export function unblockSender(id: string, channel: string): void {
  const state = readState();
  state.blocked = state.blocked.filter(s => !(s.id === id && s.channel === channel));
  writeState(state);
  log.info(`Unblocked sender ${id} on ${channel}`);
}

export function getDenialCount(id: string, channel: string): number {
  const state = readState();
  return state.denied.find(s => s.id === id && s.channel === channel)?.denial_count ?? 0;
}

export function getPending(id: string, channel: string): PendingSender | undefined {
  return readState().pending.find(s => s.id === id && s.channel === channel);
}

export function isPending(id: string, channel: string): boolean {
  return getPending(id, channel) !== undefined;
}

// ── Rate limiting (channel-aware) ───────────────────────────

const _incomingWindows = new Map<string, number[]>();
const _outgoingBuckets = new Map<string, { tokens: number; lastRefill: number }>();

export function checkIncomingRate(senderId: string, channel: string, maxPerMinute = 30): boolean {
  const key = `${channel}:${senderId}`;
  const now = Date.now();
  let timestamps = _incomingWindows.get(key) ?? [];
  timestamps = timestamps.filter(t => now - t < 60_000);
  if (timestamps.length >= maxPerMinute) {
    _incomingWindows.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  _incomingWindows.set(key, timestamps);
  return true;
}

export function checkOutgoingRate(recipientId: string, channel: string, maxPerMinute = 20): boolean {
  const key = `${channel}:${recipientId}`;
  const now = Date.now();
  let bucket = _outgoingBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: maxPerMinute, lastRefill: now };
    _outgoingBuckets.set(key, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(maxPerMinute, bucket.tokens + (elapsed / 60_000) * maxPerMinute);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ── Framework Integration ───────────────────────────────────

/**
 * Register the agent's 5-tier classifier with the kithkit framework.
 * The framework calls registered classifiers before its own defaults.
 * We use a single classifier that handles all agent tiers.
 *
 * Note: The framework classifier takes a single senderId string.
 * For channel-aware classification, the Telegram adapter calls
 * classifyAgentSender() directly. This framework hook catches
 * any sender checks that go through the framework's classifySender().
 */
export function initAgentAccessControl(): void {
  registerTier('agent-extended', (senderId: string) => {
    // Parse channel from senderId if encoded (e.g., "telegram:12345")
    const colonIdx = senderId.indexOf(':');
    if (colonIdx > 0) {
      const channel = senderId.slice(0, colonIdx);
      const id = senderId.slice(colonIdx + 1);
      return classifyAgentSender(id, channel);
    }
    // No channel prefix — return null to let the framework handle it
    return null;
  });
  log.info('Agent access control initialized (5-tier, channel-aware)');
}

// ── Testing ─────────────────────────────────────────────────

export function _resetForTesting(): void {
  _incomingWindows.clear();
  _outgoingBuckets.clear();
}
