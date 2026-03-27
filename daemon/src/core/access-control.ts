/**
 * Access Control Engine — sender classification and rate limiting.
 *
 * Framework provides 3 base tiers: Safe, Unknown, Blocked.
 * Extensions can register additional tiers via registerTier().
 * Rate limits are enforced per tier with configurable windows.
 *
 * Safe/blocked senders are resolved from both config and the contacts
 * table (contacts tagged with tier:safe or tier:blocked). The contacts
 * table is checked when a sender isn't found in the config-based sets,
 * giving the DB a fallback role that works without any extension code.
 */

import { createLogger } from './logger.js';
import { getDatabase } from './db.js';

const log = createLogger('access-control');

// ── Types ───────────────────────────────────────────────────

export enum SenderTier {
  Safe = 'safe',
  Unknown = 'unknown',
  Blocked = 'blocked',
}

export interface TierConfig {
  maxPerMinute: number;
}

export type TierClassifier = (senderId: string) => SenderTier | string | null;

export interface AccessControlConfig {
  safeSenders: string[];
  blockedSenders?: string[];
  tierLimits?: Record<string, TierConfig>;
}

export interface RateLimitResult {
  allowed: boolean;
  tier: string;
  remaining: number;
  resetMs: number;
}

// ── State ───────────────────────────────────────────────────

const WINDOW_MS = 60_000; // 1 minute sliding window

const DEFAULT_LIMITS: Record<string, TierConfig> = {
  [SenderTier.Safe]: { maxPerMinute: 100 },
  [SenderTier.Unknown]: { maxPerMinute: 5 },
  [SenderTier.Blocked]: { maxPerMinute: 0 },
};

let _safeSenders = new Set<string>();
let _blockedSenders = new Set<string>();
let _tierLimits: Record<string, TierConfig> = { ...DEFAULT_LIMITS };
let _customClassifiers: Array<{ name: string; classifier: TierClassifier }> = [];
let _requestLog = new Map<string, number[]>(); // senderId -> timestamps

// ── Configuration ───────────────────────────────────────────

/**
 * Configure the access control engine.
 * Call this during daemon init with values from config.
 */
export function configureAccessControl(config: AccessControlConfig): void {
  _safeSenders = new Set(config.safeSenders);
  _blockedSenders = new Set(config.blockedSenders ?? []);
  if (config.tierLimits) {
    _tierLimits = { ...DEFAULT_LIMITS, ...config.tierLimits };
  }
  log.info('Access control configured', {
    safeSenders: _safeSenders.size,
    blockedSenders: _blockedSenders.size,
    tiers: Object.keys(_tierLimits),
  });
}

// ── Extension hooks ─────────────────────────────────────────

/**
 * Register a custom tier classifier.
 * Custom classifiers are checked in order before the default classification.
 * Return a tier string to classify, or null to pass to the next classifier.
 */
export function registerTier(name: string, classifier: TierClassifier): void {
  _customClassifiers.push({ name, classifier });
  log.info(`Registered custom tier classifier: ${name}`);
}

// ── Contacts DB lookup ──────────────────────────────────────

/**
 * Check the contacts table for a sender's tier tag.
 * Looks up by telegram_id or email, returns the first tier:* tag found.
 * Returns null if no matching contact or no tier tag.
 */
function checkContactsTier(senderId: string): string | null {
  try {
    const db = getDatabase();
    const row = db.prepare(
      "SELECT tags, role FROM contacts WHERE telegram_id = ? OR email LIKE ? LIMIT 1"
    ).get(senderId, `%${senderId}%`) as { tags: string; role: string | null } | undefined;
    if (!row) return null;

    // Owner role implies safe
    if (row.role === 'owner') return SenderTier.Safe;

    let tags: string[] = [];
    try { tags = JSON.parse(row.tags); } catch { /* ignore */ }

    if (tags.includes('tier:blocked')) return SenderTier.Blocked;
    if (tags.includes('tier:safe')) return SenderTier.Safe;
    return null;
  } catch {
    // DB not available (e.g., during tests or early init) — skip silently
    return null;
  }
}

// ── Classification ──────────────────────────────────────────

/**
 * Classify a sender into a tier.
 * Custom classifiers are checked first, then config-based sets,
 * then the contacts table as a fallback.
 */
export function classifySender(senderId: string): string {
  // Check custom classifiers first (extensions)
  for (const { classifier } of _customClassifiers) {
    const result = classifier(senderId);
    if (result !== null) return result;
  }

  // Config-based classification
  if (_blockedSenders.has(senderId)) return SenderTier.Blocked;
  if (_safeSenders.has(senderId)) return SenderTier.Safe;

  // Contacts DB fallback — check for tier tags on matching contacts
  const contactTier = checkContactsTier(senderId);
  if (contactTier !== null) return contactTier;

  return SenderTier.Unknown;
}

/**
 * Add a sender to the safe list at runtime.
 */
export function addSafeSender(senderId: string): void {
  _safeSenders.add(senderId);
  _blockedSenders.delete(senderId);
  log.info(`Added safe sender: ${senderId}`);
}

/**
 * Block a sender at runtime.
 */
export function blockSender(senderId: string): void {
  _blockedSenders.add(senderId);
  _safeSenders.delete(senderId);
  log.info(`Blocked sender: ${senderId}`);
}

// ── Rate Limiting ───────────────────────────────────────────

/**
 * Check if a request from a sender is allowed under rate limits.
 * Records the request if allowed.
 */
export function checkRateLimit(senderId: string): RateLimitResult {
  const tier = classifySender(senderId);
  const limits = _tierLimits[tier] ?? DEFAULT_LIMITS[SenderTier.Unknown]!;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Get or create request log
  let timestamps = _requestLog.get(senderId) ?? [];
  // Prune old entries
  timestamps = timestamps.filter(t => t > windowStart);

  const remaining = Math.max(0, limits.maxPerMinute - timestamps.length);
  const allowed = timestamps.length < limits.maxPerMinute;

  if (allowed) {
    timestamps.push(now);
    _requestLog.set(senderId, timestamps);
  } else {
    log.warn(`Rate limited sender ${senderId} (tier: ${tier})`);
  }

  // Time until oldest entry expires
  const resetMs = timestamps.length > 0
    ? Math.max(0, timestamps[0]! + WINDOW_MS - now)
    : 0;

  return { allowed, tier, remaining: allowed ? remaining - 1 : 0, resetMs };
}

// ── Queries ─────────────────────────────────────────────────

/**
 * Get all safe senders.
 */
export function getSafeSenders(): string[] {
  return [..._safeSenders];
}

/**
 * Get all blocked senders.
 */
export function getBlockedSenders(): string[] {
  return [..._blockedSenders];
}

/**
 * Get the rate limit config for a tier.
 */
export function getTierLimit(tier: string): TierConfig | undefined {
  return _tierLimits[tier];
}

// ── Testing ─────────────────────────────────────────────────

/** Reset all state for testing. */
export function _resetForTesting(): void {
  _safeSenders = new Set();
  _blockedSenders = new Set();
  _tierLimits = { ...DEFAULT_LIMITS };
  _customClassifiers = [];
  _requestLog = new Map();
}
