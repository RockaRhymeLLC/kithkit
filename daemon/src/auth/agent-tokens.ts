/**
 * Agent Token Auth — issue, verify, and revoke per-agent tokens.
 *
 * Tokens are stored in the agent_tokens table (see migration 026).
 * The comms agent gets a long-lived token written to .kithkit/.comms-token.
 * Workers get a short-lived token injected via KITHKIT_AGENT_TOKEN env var
 * and revoked when their job finishes.
 *
 * Used by /api/send to enforce the worker → orchestrator → comms → human chain.
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../core/db.js';

// ── Types ────────────────────────────────────────────────────

export interface TokenIdentity {
  role: string;
  jobId: string | null;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Issue a new cryptographically random token for the given role.
 * Inserts a row into agent_tokens and returns the raw token string.
 */
export function issueToken(
  role: 'comms' | 'orchestrator' | 'worker',
  metadata?: { jobId?: string },
): string {
  const token = randomBytes(32).toString('hex');
  const db = getDatabase();
  db.prepare(
    `INSERT INTO agent_tokens (token, role, job_id, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(token, role, metadata?.jobId ?? null);
  return token;
}

/**
 * Verify a token.
 * Returns the role and jobId if the token exists and has not been revoked.
 * Returns null if the token is unknown or revoked.
 */
export function verifyToken(token: string): TokenIdentity | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT role, job_id FROM agent_tokens WHERE token = ? AND revoked_at IS NULL`,
  ).get(token) as { role: string; job_id: string | null } | undefined;
  if (!row) return null;
  return { role: row.role, jobId: row.job_id };
}

/**
 * Revoke a token by setting its revoked_at timestamp.
 * No-op if the token is already revoked or does not exist.
 */
export function revokeToken(token: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE agent_tokens SET revoked_at = datetime('now') WHERE token = ?`,
  ).run(token);
}

/**
 * Revoke all active tokens for a given job ID.
 * Called when a worker job completes or fails.
 */
export function revokeTokensByJobId(jobId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE agent_tokens SET revoked_at = datetime('now')
     WHERE job_id = ? AND revoked_at IS NULL`,
  ).run(jobId);
}
