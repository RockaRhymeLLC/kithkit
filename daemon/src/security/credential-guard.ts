/**
 * Write-path credential guard.
 *
 * Refuses to persist a string value into a small set of high-exposure
 * columns (worker_jobs.prompt/result/error, tasks.work_notes/result/error)
 * when that value contains a live agent token or looks like a third-party
 * secret. Those five columns are served back to unauthenticated LAN callers
 * (GET /api/agents/:id, GET /api/orchestrator/tasks/:id, etc.), and in
 * practice agents leak credentials into them by transcribing a successful
 * `$(cat token-file)` command into their own written-up prose — not by
 * mishandling the credential itself. No amount of documentation telling
 * agents to use `$VAR` instead of the expanded value fixes that, because the
 * agent isn't reusing the command, it's quoting its own past output. Only a
 * mechanical check on the value actually being written can catch it.
 *
 * Two independent detection layers:
 *   1. Oracle — exact match against tokens this daemon actually issued
 *      (agent_tokens table). No false positives: it answers "was this
 *      credential actually issued", not "does this look like one".
 *   2. Shape — a short allowlist of high-confidence third-party secret
 *      formats (JWT, GitHub token, Anthropic API key), for credentials the
 *      oracle can't know about because we didn't issue them.
 *
 * Deliberately NOT implemented: classification by surrounding words
 * ("Bearer", "token", "X-Agent-Token", etc). A prior classifier used
 * context-word allowlisting and it inverted twice in the field — once
 * suppressing 3 of 4 real leaks because the surrounding text said "agent",
 * once flagging benign header names/service names as secrets. Decide on the
 * value alone.
 */

import { getDatabase } from '../core/db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('security:credential-guard');

// ── Errors ───────────────────────────────────────────────────

export type CredentialMatchType = 'oracle' | 'shape';

export class CredentialLeakError extends Error {
  readonly table: string;
  readonly field: string;
  readonly matchType: CredentialMatchType;
  readonly shapeKind?: string;

  constructor(table: string, field: string, matchType: CredentialMatchType, shapeKind?: string) {
    const detail = matchType === 'oracle'
      ? 'a live agent token'
      : `a ${shapeKind} credential`;
    super(
      `Refusing to persist ${table}.${field}: the value contains ${detail}. ` +
      'Rewrite this field without the literal credential (reference it by name/fingerprint instead) and resubmit.',
    );
    this.name = 'CredentialLeakError';
    this.table = table;
    this.field = field;
    this.matchType = matchType;
    this.shapeKind = shapeKind;
  }
}

// ── Layer 1: Oracle — exact match against issued agent tokens ──

interface TokenCache {
  tokens: Set<string>;
  loadedAt: number;
}

// The active set is tiny (5 of 679 rows on the box this was built for) and
// changes rarely (mint/revoke), so an in-process cache with a short TTL
// avoids a DB round trip on every write while staying acceptably fresh.
// agent-tokens.ts (mint/revoke) is out of scope for this change — it's
// mid-flight in another open PR — so this cache cannot hook an explicit
// invalidation call into issueToken()/revokeToken(). TTL-based refresh is
// the pragmatic substitute; invalidateCredentialGuardCache() is exposed for
// callers (tests, and a future integration) that want to force a reload.
const ORACLE_CACHE_TTL_MS = 10_000;

// Design call: match against ACTIVE tokens (revoked_at IS NULL), not all 679
// rows. A revoked token can no longer authenticate anything, so scanning
// the full historical table would mean flagging writes over dead credentials
// with no ongoing access risk, while paying to hold/scan hundreds of rows
// forever. The one case that argues for including revoked tokens is a
// rotation race: a token revoked moments before (or after) the leak-write
// lands would be invisible to a pure active-only oracle. To close that
// without reverting to "match everything", the oracle set also includes
// tokens revoked within the last 24h — bounded, still tiny in practice, and
// covers the realistic race window (revocation happening around job
// completion) without carrying years of dead tokens.
const REVOCATION_GRACE_MS = 24 * 60 * 60 * 1000;

let _cache: TokenCache | null = null;

function loadOracleTokens(): Set<string> {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - REVOCATION_GRACE_MS).toISOString();
  const rows = db.prepare(
    `SELECT token FROM agent_tokens WHERE revoked_at IS NULL OR revoked_at > ?`,
  ).all(cutoff) as { token: string }[];
  return new Set(rows.map(r => r.token));
}

function getOracleTokens(): Set<string> {
  const now = Date.now();
  if (!_cache || now - _cache.loadedAt > ORACLE_CACHE_TTL_MS) {
    _cache = { tokens: loadOracleTokens(), loadedAt: now };
  }
  return _cache.tokens;
}

/** Force the next check to reload the oracle set from the DB. Exposed for tests. */
export function invalidateCredentialGuardCache(): void {
  _cache = null;
}

function findOracleMatch(value: string): boolean {
  const tokens = getOracleTokens();
  if (tokens.size === 0) return false;
  for (const token of tokens) {
    if (value.includes(token)) return true;
  }
  return false;
}

// ── Layer 2: Shape — high-confidence third-party secret formats ──

// Deliberately small. The oracle (layer 1) is the primary control for
// anything this daemon issued; these patterns exist only to catch
// third-party credentials the oracle can't know about. Resist growing this
// list — broad "looks like a secret" heuristics are exactly the kind of
// classifier that misfires in both directions.
const SHAPE_PATTERNS: ReadonlyArray<{ kind: string; regex: RegExp }> = [
  // JWT: three dot-separated base64url segments, header/payload start "eyJ"
  { kind: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // GitHub personal/OAuth/user/server/refresh tokens
  { kind: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  // Anthropic API key
  { kind: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
];

function findShapeMatch(value: string): string | null {
  for (const { kind, regex } of SHAPE_PATTERNS) {
    if (regex.test(value)) return kind;
  }
  return null;
}

// ── Combined check ───────────────────────────────────────────

export interface CredentialCheckResult {
  blocked: boolean;
  matchType?: CredentialMatchType;
  shapeKind?: string;
}

/**
 * Check a single string value for a credential leak. Layer 1 (oracle) is
 * checked first since it is authoritative and exact; layer 2 (shape) only
 * runs if the oracle didn't already match.
 */
export function checkForCredentialLeak(value: string): CredentialCheckResult {
  if (findOracleMatch(value)) {
    return { blocked: true, matchType: 'oracle' };
  }
  const shapeKind = findShapeMatch(value);
  if (shapeKind) {
    return { blocked: true, matchType: 'shape', shapeKind };
  }
  return { blocked: false };
}

// ── Watched fields ───────────────────────────────────────────

/**
 * Table/column combinations this guard protects. Minimum required coverage
 * per the incident: worker_jobs.prompt/result/error and tasks.work_notes/
 * result. tasks.error is included too — same risk shape (agent-authored
 * free text served to unauthenticated LAN callers), guarding it is a
 * one-line addition once the mechanism exists.
 *
 * Extended coverage (field-class sweep, follow-up to the original incident):
 * the original list was built by naming columns from memory, which is a
 * denylist by construction — it missed worker_jobs.verification_report, a
 * fact-verifier write with the exact same shape (agent-authored prose,
 * served to unauthenticated LAN callers). Rather than add that one field
 * and stop, every prose column across worker_jobs/tasks that a live HTTP
 * write path accepts from a request body was audited. Added here:
 *   worker_jobs.verification_report — fact-verifier's persisted claim
 *     report; the report JSON embeds claim.reason strings derived from
 *     job.result, so it inherits that field's leak risk.
 *   tasks.description — task/todo body text, set at creation and via PUT.
 *   tasks.plan — orchestrator/worker plan text (plan-approval workflow).
 *   tasks.plan_rejected_reason — human/comms plan-rejection feedback.
 *   tasks.outcome_reason — orchestrator's free-text outcome explanation.
 *   tasks.comms_corrections — comms-authored correction notes on a task.
 * Deliberately NOT added here (enum/machine-generated columns carry no
 * transcription risk): tasks.status/priority/outcome/comms_outcome/
 * plan_status/last_retry_reason (CHECK-constrained), tasks.requesting_peer
 * (regex-validated short identifier), worker_jobs.verification_status
 * (enum) and verification_flagged_at/resolved_model/turns_used (timestamp/
 * machine values). See the PR description for the full field-class sweep,
 * including tables outside this guard's current reach (task_activity.message
 * gained its own guard at the two live-request-body write sites; other
 * tables — messages, memories, conversation_messages, wiki_articles,
 * task_results — were reviewed and left for a dedicated follow-up, since
 * their write paths have many callers with mixed sync/fire-and-forget
 * semantics that a single-PR sweep can't safely convert wholesale).
 */
export const WATCHED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  worker_jobs: ['prompt', 'result', 'error', 'verification_report'],
  tasks: ['work_notes', 'result', 'error', 'description', 'plan', 'plan_rejected_reason', 'outcome_reason', 'comms_corrections'],
  task_activity: ['message'],
};

// ── Enforcement: reject ──────────────────────────────────────

/**
 * Throw if `value` contains a credential. Use this at write paths that have
 * a live synchronous caller who can act on the rejection — an HTTP request
 * handler can return 400 and the calling agent can rewrite the field and
 * retry. This is the default/preferred posture: nothing is persisted, so
 * there is no data loss, and the caller gets an actionable error instead of
 * a silent drop.
 */
export function assertFieldSafe(table: string, field: string, value: string): void {
  const check = checkForCredentialLeak(value);
  if (!check.blocked) return;
  log.error('credential-guard: rejected write', {
    table, field, matchType: check.matchType, shapeKind: check.shapeKind,
  });
  throw new CredentialLeakError(table, field, check.matchType!, check.shapeKind);
}

/**
 * Run assertFieldSafe over every watched field present (and a string) in
 * `data` for `table`. No-op for tables with no watched fields. Intended as
 * a single call right before an INSERT/UPDATE is executed, whether that
 * write goes through the generic db.ts helpers or hand-rolled SQL.
 */
export function assertRecordSafe(table: string, data: Record<string, unknown>): void {
  const fields = WATCHED_FIELDS[table];
  if (!fields) return;
  for (const field of fields) {
    const value = data[field];
    if (typeof value === 'string') {
      assertFieldSafe(table, field, value);
    }
  }
}

// ── Enforcement: loud placeholder ────────────────────────────

const PLACEHOLDER_PREFIX = '[CREDENTIAL-GUARD-BLOCKED]';

/**
 * Return `value` unchanged, or a loud, labelled placeholder if it contains
 * a credential. Use this ONLY where there is no live caller to hand a
 * rejection to — specifically, a worker's own completion write
 * (worker_jobs.result/error at job finish). The worker process has already
 * exited by the time that write happens, so throwing there would discard
 * the entire job's legitimate output (status, tokens, cost, timing) along
 * with the secret — its own kind of data loss, and worse, a SILENT one: no
 * caller is waiting on that write to see an error. A labelled placeholder
 * keeps the rest of the job record intact, is visible wherever the field is
 * displayed, and is logged at error level — the opposite of the silent
 * redaction this guard exists to avoid. The secret value itself is never
 * logged, only the detection metadata (table/field/matchType/shapeKind).
 */
export function guardOrPlaceholder(table: string, field: string, value: string): string {
  const check = checkForCredentialLeak(value);
  if (!check.blocked) return value;
  log.error('credential-guard: blocked write, persisted placeholder instead', {
    table, field, matchType: check.matchType, shapeKind: check.shapeKind,
  });
  const detail = check.matchType === 'oracle' ? 'a live agent token' : `a ${check.shapeKind} credential`;
  return `${PLACEHOLDER_PREFIX} ${table}.${field} was not persisted — the original value contained ${detail} ` +
    'and was blocked by the write-path credential guard. Original value discarded; see daemon logs for detection metadata (no secret value logged).';
}

/**
 * sanitizeRecordOrPlaceholder variant of assertRecordSafe: returns a shallow
 * copy of `data` with any blocked watched field replaced by a placeholder,
 * instead of throwing. See guardOrPlaceholder for when to use this.
 */
export function sanitizeRecordOrPlaceholder<T extends Record<string, unknown>>(table: string, data: T): T {
  const fields = WATCHED_FIELDS[table];
  if (!fields) return data;
  const out: Record<string, unknown> = { ...data };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string') {
      out[field] = guardOrPlaceholder(table, field, value);
    }
  }
  return out as T;
}
