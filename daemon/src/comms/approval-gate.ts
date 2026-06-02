/**
 * Approval Gate — outbound-send middleware for human-in-the-loop approval.
 *
 * Implements the approval workflow spec (approval-workflow.md Phase 2):
 *   [content assembly] → [approvalGate] → [transport.send]
 *
 * The gate is interposed in the channel-router outbound path. Every outbound
 * capability send passes through it before the adapter's transport is called.
 *
 * Fail-closed invariants (hard design, not config):
 *   - Policy tie → require approval
 *   - Timeout expiry → false (denied)
 *   - Unrecognized require_approval_for → treat as 'all'
 *   - Any infrastructure failure while gate is pending → fail-closed
 *   - Daemon restart while gate is pending → resolved DENIED on startup sweep
 *
 * Hash construction (per spec):
 *   content_hash       = SHA-256(original content as UTF-8)
 *   recipient_set_hash = SHA-256(JSON.stringify(recipients.map(canonical).sort()))
 */

import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from '../core/config.js';
import { getDatabase } from '../core/db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('approval-gate');

// ── Types ────────────────────────────────────────────────────

export type ApprovalPolicy = 'all' | 'first_time_recipient' | 'external_only' | 'never';

export interface ApprovalPolicyConfig {
  require_approval_for: ApprovalPolicy;
  timeout_minutes: number;
}

export interface ApprovalPolicies {
  [channel: string]: ApprovalPolicyConfig;
}

export interface GateContext {
  /** Capability/channel identifier: 'mail', 'teams_chat', 'calendar', adapter name, etc. */
  channel: string;
  /** Canonical recipient addresses or user IDs */
  recipient: string[];
  /** Assembled message body — used for hashing and preview */
  content: string;
  /** Original message text before channel formatting — used for content_hash (see FIX #2).
   *  MUST be the pre-format raw text so hashes are stable across channel formatters. */
  rawContent: string;
  /** Agent name: 'bridget', 'bmo', etc. */
  sender_agent: string;
}

export interface ApprovalCard {
  approval_id: string;
  channel: string;
  recipient: string[];
  preview: string;
  sender_agent: string;
  policy: string;
  expires_at: string;  // ISO8601
}

export interface PendingGate {
  card: ApprovalCard;
  resolve: (approved: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  created_at: string;
  content_hash: string;
  recipient_set_hash: string;
}

// ── Notification channel callback ─────────────────────────────────────

/**
 * The gate calls this function to deliver approval cards to the human.
 * Must be registered before the gate can issue cards.
 * Default: noop (fails silently — caller should always register).
 */
let _cardDeliveryFn: ((card: ApprovalCard) => Promise<void>) | null = null;

export function registerCardDelivery(fn: (card: ApprovalCard) => Promise<void>): void {
  _cardDeliveryFn = fn;
}

// ── Pending gate registry ─────────────────────────────────────────────

const _pendingGates = new Map<string, PendingGate>();

export function getPendingGates(): Map<string, PendingGate> {
  return _pendingGates;
}

// ── Hash helpers ──────────────────────────────────────────────────────

/** SHA-256 of content string as UTF-8. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** SHA-256 of JSON-sorted canonical recipient list — order-independent. */
export function hashRecipientSet(recipients: string[]): string {
  const canonical = recipients.map(r => canonicalizeRecipient(r)).sort();
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** Canonical email: lowercase, trimmed. */
export function canonicalizeRecipient(address: string): string {
  return address.trim().toLowerCase();
}

// ── Policy helpers ────────────────────────────────────────────────────

/**
 * Load approval policies from config.
 * Returns empty object if no approval_policies block exists.
 */
function getApprovalPolicies(): ApprovalPolicies {
  const cfg = loadConfig() as unknown as Record<string, unknown>;
  const policies = cfg.approval_policies as ApprovalPolicies | undefined;
  return policies ?? {};
}

/**
 * Resolve the policy for a channel. Returns null if the channel is not in the
 * policy store (i.e., it is not a gated capability — passes through).
 */
export function resolvePolicy(channel: string): ApprovalPolicyConfig | null {
  const policies = getApprovalPolicies();
  return policies[channel] ?? null;
}

/**
 * Normalize a require_approval_for value. Unrecognized values → 'all' (fail-closed).
 */
export function normalizeApprovalFor(raw: string): ApprovalPolicy {
  const valid: ApprovalPolicy[] = ['all', 'first_time_recipient', 'external_only', 'never'];
  if (valid.includes(raw as ApprovalPolicy)) return raw as ApprovalPolicy;
  log.warn(`Unrecognized require_approval_for value "${raw}" — treating as "all" (fail-closed)`);
  return 'all';
}

// ── first_time_recipient tracking ─────────────────────────────────────

/**
 * Check if a (agent, recipient) pair is known (previously sent to).
 * Uses UNIQUE(agent, recipient) table as the source of truth.
 */
function isKnownRecipient(agent: string, recipient: string): boolean {
  const db = getDatabase();
  const canonical = canonicalizeRecipient(recipient);
  const row = db.prepare(
    'SELECT id FROM agent_sent_recipients WHERE agent = ? AND recipient = ?',
  ).get(agent, canonical);
  return row != null;
}

/**
 * Record a successful send. INSERT OR IGNORE — dedup on add.
 * A rejected send does NOT add the recipient.
 */
export function recordSuccessfulSend(agent: string, recipients: string[]): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO agent_sent_recipients (agent, recipient, first_sent_at) VALUES (?, ?, ?)',
  );
  for (const r of recipients) {
    const canonical = canonicalizeRecipient(r);
    stmt.run(agent, canonical, now);
  }
}

// ── Decision audit logging ────────────────────────────────────────────

export interface DecisionRow {
  approval_id: string;
  decision: 'pending' | 'approved' | 'rejected' | 'timeout';
  decider: 'human' | 'system';
  time_to_decide: number | null;
  content_hash: string;
  recipient_set_hash: string;
  sender_agent: string;
  channel: string;
  policy: string;
  created_at: string;
  decided_at: string | null;
}

function writeDecisionRow(row: DecisionRow): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO approval_decisions
      (approval_id, decision, decider, time_to_decide, content_hash, recipient_set_hash,
       sender_agent, channel, policy, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.approval_id,
    row.decision,
    row.decider,
    row.time_to_decide ?? null,
    row.content_hash,
    row.recipient_set_hash,
    row.sender_agent,
    row.channel,
    row.policy,
    row.created_at,
    row.decided_at ?? null,
  );
}

// ── Content redaction ─────────────────────────────────────────────────

/** Targeted regex patterns for credential/PII detection in preview redaction.
 *  Conservative — avoids over-redacting normal prose, URLs, and UUIDs. */
const REDACT_PATTERNS = [
  /-----BEGIN [A-Z ]+-----/,                        // PEM boundaries (private keys, certs)
  /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}\b/i,  // Bearer <token> in Authorization header
  /\bAKIA[0-9A-Z]{16}\b/,                           // AWS access key IDs
  /[A-Za-z0-9+/]{40,}={0,2}(?:[^A-Za-z0-9+/=]|$)/, // Long base64 key blobs (40+ chars)
];

function shouldRedactContent(content: string): boolean {
  return REDACT_PATTERNS.some(p => p.test(content));
}

function buildPreview(content: string): string {
  if (shouldRedactContent(content)) return '[content redacted by policy]';
  return content.length > 200 ? content.slice(0, 200) : content;
}

// ── Core gate logic ────────────────────────────────────────────────────

/**
 * Evaluate whether a send requires approval for this context.
 * Returns one of: 'never' (pass), 'all' (gate), 'first_time_recipient' (check), 'external_only' (check).
 */
function evaluateRequirement(
  policy: ApprovalPolicyConfig,
  ctx: GateContext,
): 'pass' | 'gate' {
  const requirement = normalizeApprovalFor(policy.require_approval_for);

  if (requirement === 'never') return 'pass';

  if (requirement === 'all') return 'gate';

  if (requirement === 'first_time_recipient') {
    // Gate if ANY recipient is unknown to this agent
    const anyUnknown = ctx.recipient.some(r => !isKnownRecipient(ctx.sender_agent, r));
    return anyUnknown ? 'gate' : 'pass';
  }

  if (requirement === 'external_only') {
    // Gate if ANY recipient is external (different domain).
    // For now, we cannot determine the agent's tenant domain without config,
    // so we treat this conservatively: gate unless ALL recipients share the same
    // domain as the sender_agent's configured domain.
    // TODO: Read tenant domain from config when available.
    // Conservative fallback: treat all as external → gate.
    return 'gate';
  }

  // Unrecognized (should have been normalized above) → gate (fail-closed)
  return 'gate';
}

/**
 * Core approval gate function.
 *
 * Returns true → proceed with send.
 * Returns false → abort send (rejected or timed out).
 *
 * Blocks until the human responds or the timeout fires.
 */
export async function approvalGate(ctx: GateContext): Promise<boolean> {
  const policy = resolvePolicy(ctx.channel);

  // No policy entry → this channel is not a gated capability → pass through.
  if (policy === null) {
    log.debug(`No approval policy for channel "${ctx.channel}" — passing through`, { channel: ctx.channel });
    return true;
  }

  const requirement = evaluateRequirement(policy, ctx);
  const contentHash = hashContent(ctx.rawContent);
  const recipientHash = hashRecipientSet(ctx.recipient);
  const createdAt = new Date().toISOString();
  const normalizedPolicy = normalizeApprovalFor(policy.require_approval_for);

  if (requirement === 'pass') {
    // 'never' policy — auto-approved, still write audit row
    log.info(`Approval gate: auto-approved (policy=never)`, { channel: ctx.channel, sender: ctx.sender_agent });
    writeDecisionRow({
      approval_id: randomUUID(),
      decision: 'approved',
      decider: 'system',
      time_to_decide: 0,
      content_hash: contentHash,
      recipient_set_hash: recipientHash,
      sender_agent: ctx.sender_agent,
      channel: ctx.channel,
      policy: normalizedPolicy,
      created_at: createdAt,
      decided_at: createdAt,
    });
    return true;
  }

  // Requires gate — build card and wait for human decision
  const approvalId = randomUUID();
  const timeoutMs = (policy.timeout_minutes ?? 10) * 60 * 1000;
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

  const card: ApprovalCard = {
    approval_id: approvalId,
    channel: ctx.channel,
    recipient: ctx.recipient,
    preview: buildPreview(ctx.content),
    sender_agent: ctx.sender_agent,
    policy: normalizedPolicy,
    expires_at: expiresAt,
  };

  // Write pending row first (decided_at = null)
  writeDecisionRow({
    approval_id: approvalId,
    decision: 'pending',        // placeholder — overwritten with 'approved'/'rejected'/'timeout' on resolution
    decider: 'human',            // placeholder — updated on decision
    time_to_decide: null,
    content_hash: contentHash,
    recipient_set_hash: recipientHash,
    sender_agent: ctx.sender_agent,
    channel: ctx.channel,
    policy: normalizedPolicy,
    created_at: createdAt,
    decided_at: null,
  });

  return new Promise<boolean>((resolve) => {
    let resolved = false;

    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      _pendingGates.delete(approvalId);

      log.warn(`Approval gate timed out`, { approval_id: approvalId, channel: ctx.channel });

      // Update DB row: decision=timeout, decider=system
      const decidedAt = new Date().toISOString();
      const db = getDatabase();
      db.prepare(`
        UPDATE approval_decisions
        SET decision = 'timeout', decider = 'system', decided_at = ?,
            time_to_decide = (
              SELECT CAST((JULIANDAY(?) - JULIANDAY(created_at)) * 86400 AS REAL)
              FROM approval_decisions WHERE approval_id = ? AND decided_at IS NULL
              LIMIT 1
            )
        WHERE approval_id = ? AND decided_at IS NULL
      `).run(decidedAt, decidedAt, approvalId, approvalId);

      resolve(false);
    }, timeoutMs);

    _pendingGates.set(approvalId, {
      card,
      resolve: (approved: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutHandle);
        _pendingGates.delete(approvalId);
        resolve(approved);
      },
      timeoutHandle,
      created_at: createdAt,
      content_hash: contentHash,
      recipient_set_hash: recipientHash,
    });

    // Deliver the approval card asynchronously — don't await, gate is already waiting
    if (_cardDeliveryFn) {
      _cardDeliveryFn(card).catch(err => {
        log.error('Failed to deliver approval card', {
          approval_id: approvalId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Card delivery failed — fail-closed: resolve as denied
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          _pendingGates.delete(approvalId);

          const decidedAt = new Date().toISOString();
          const db = getDatabase();
          db.prepare(`
            UPDATE approval_decisions
            SET decision = 'timeout', decider = 'system', decided_at = ?
            WHERE approval_id = ? AND decided_at IS NULL
          `).run(decidedAt, approvalId);

          resolve(false);
        }
      });
    } else {
      log.error('No card delivery function registered — failing closed', { approval_id: approvalId });
      // Fail-closed: no delivery means no approval
      resolved = true;
      clearTimeout(timeoutHandle);
      _pendingGates.delete(approvalId);

      const decidedAt = new Date().toISOString();
      const db = getDatabase();
      db.prepare(`
        UPDATE approval_decisions
        SET decision = 'timeout', decider = 'system', decided_at = ?
        WHERE approval_id = ? AND decided_at IS NULL
      `).run(decidedAt, approvalId);

      resolve(false);
    }
  });
}

/**
 * Resolve a pending gate with a human decision.
 * Returns true if resolved, false if the approval_id is not found.
 */
export function resolveGate(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decider: string = 'human',
): 'ok' | 'not_found' | 'already_resolved' {
  const gate = _pendingGates.get(approvalId);
  if (!gate) {
    // Check if it's in the DB (already resolved or expired)
    const db = getDatabase();
    const row = db.prepare(
      'SELECT decided_at FROM approval_decisions WHERE approval_id = ?',
    ).get(approvalId) as { decided_at: string | null } | undefined;

    if (!row) return 'not_found';
    if (row.decided_at !== null) return 'already_resolved';
    // Pending in DB but not in memory — shouldn't happen, treat as not found
    return 'not_found';
  }

  const decidedAt = new Date().toISOString();
  const createdAt = gate.created_at;
  const timeToDecide = (Date.now() - new Date(createdAt).getTime()) / 1000;

  // Update DB row
  const db = getDatabase();
  db.prepare(`
    UPDATE approval_decisions
    SET decision = ?, decider = ?, decided_at = ?, time_to_decide = ?
    WHERE approval_id = ? AND decided_at IS NULL
  `).run(decision, decider, decidedAt, timeToDecide, approvalId);

  // Resolve the waiting promise
  gate.resolve(decision === 'approved');

  log.info(`Gate resolved by human`, { approval_id: approvalId, decision });
  return 'ok';
}

// ── Restart sweep ─────────────────────────────────────────────────────

/**
 * On daemon startup: sweep any approval_decisions rows where decided_at IS NULL
 * and created_at is older than the per-policy timeout.
 *
 * These represent gates that were interrupted by a daemon restart. Per the spec
 * (MED-2 restart invariant), they MUST resolve as DENIED.
 *
 * Also handles the edge case where a gate is within its timeout window at restart:
 * we mark it timed-out rather than silently auto-resuming (the card was lost when
 * the daemon died — the human never saw it in this process).
 */
export function sweepStaleApprovals(): number {
  let swept = 0;
  try {
    const db = getDatabase();
    const now = new Date().toISOString();

    // All pending rows that were not resolved (any age — restart = fail-closed)
    const pending = db.prepare(
      `SELECT approval_id, created_at, channel FROM approval_decisions WHERE decided_at IS NULL`,
    ).all() as Array<{ approval_id: string; created_at: string; channel: string }>;

    if (pending.length === 0) return 0;

    log.warn(`Startup sweep: found ${pending.length} pending approval(s) — resolving DENIED`, {
      count: pending.length,
    });

    for (const row of pending) {
      db.prepare(`
        UPDATE approval_decisions
        SET decision = 'timeout', decider = 'system', decided_at = ?,
            time_to_decide = CAST((JULIANDAY(?) - JULIANDAY(created_at)) * 86400 AS REAL)
        WHERE approval_id = ? AND decided_at IS NULL
      `).run(now, now, row.approval_id);
      swept++;
      log.info(`Swept stale approval`, { approval_id: row.approval_id, channel: row.channel });
    }
  } catch (err) {
    log.error('Startup sweep failed — re-throwing to abort startup (fail-closed)', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Re-throw to abort daemon startup. The setDegraded() mechanism only blocks
    // extension routes, not the outbound send path, so it cannot enforce fail-closed
    // here. Crashing startup is the only safe option when the sweep DB operation fails.
    throw err;
  }
  return swept;
}

// ── Testing ───────────────────────────────────────────────────────────

export function _resetForTesting(): void {
  // Clear all pending gates (and their timeouts)
  for (const gate of _pendingGates.values()) {
    clearTimeout(gate.timeoutHandle);
  }
  _pendingGates.clear();
  _cardDeliveryFn = null;
}
