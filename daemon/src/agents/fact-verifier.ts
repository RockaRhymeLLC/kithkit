/**
 * Fact Verifier — validates claims in worker output after job completion.
 *
 * Extracts verifiable claims (PR refs with asserted titles, commit SHAs,
 * file:line citations, ISO dates, review-state assertions) from worker results
 * and validates each cheaply via gh / git / fs. Runs async, fire-and-forget,
 * with a bounded per-job timeout. Never throws — all errors → UNVERIFIABLE.
 *
 * Verdict per claim: VERIFIED | UNVERIFIABLE | CONTRADICTED
 *
 * Quarantine trigger: any CONTRADICTED claim  OR  empty/whitespace result
 * when job status === 'completed'. Quarantine annotates the job in the DB
 * and delivers a warning message to comms. It does NOT delete or rewrite
 * worker output — annotation only.
 *
 * Motivated by:
 *  - A worker reported a merged PR with an incorrect title — the asserted title
 *    did not match the real PR title in the repository
 *  - Empty-result-despite-writes: completed job with result="" that appeared
 *    clean but had performed no verifiable work
 *  - Test-stub false-passes: tests that stubbed the function under test
 *    returned green without ever exercising claim extraction
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { update, exec } from '../core/db.js';
import { sendMessage } from './message-router.js';
import { addOnJobComplete } from './lifecycle.js';
import type { JobRecord } from './lifecycle.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('fact-verifier');

// ── Tunables ─────────────────────────────────────────────────

/** Maximum wall-clock time for the entire verification of one job (ms). */
const JOB_TIMEOUT_MS = 30_000;

/** Per-subprocess wall-clock timeout (ms). */
const SUBPROCESS_TIMEOUT_MS = 8_000;

// ── Types ────────────────────────────────────────────────────

export type Verdict = 'VERIFIED' | 'UNVERIFIABLE' | 'CONTRADICTED';

export type ClaimType = 'pr' | 'commit' | 'file_line' | 'date' | 'task';

export interface PrClaim {
  type: 'pr';
  raw: string;
  prNumber: number;
  assertedTitle?: string;
  assertedReviewState?: string; // 'approved' | 'merged' | 'lgtm'
}

export interface CommitClaim {
  type: 'commit';
  raw: string;
  sha: string;
}

export interface FileLineClaim {
  type: 'file_line';
  raw: string;
  filePath: string;
  lineNumber: number;
}

export interface DateClaim {
  type: 'date';
  raw: string;
  dateStr: string;
}

export interface TaskClaim {
  type: 'task';
  raw: string;
  /** Normalized (lowercase) task ID: dashed UUID or 32-hex canonical form. */
  taskId: string;
}

export type Claim = PrClaim | CommitClaim | FileLineClaim | DateClaim | TaskClaim;

export interface ClaimResult {
  claim: Claim;
  verdict: Verdict;
  reason: string;
}

export interface VerificationReport {
  jobId: string;
  timestamp: string;
  claims: ClaimResult[];
  quarantined: boolean;
  quarantineReason?: string;
}

// ── Injectable exec (for testing) ────────────────────────────

/**
 * Exec function signature injectable for tests.
 * cmd: the executable ('gh', 'git')
 * args: argument list
 * Returns { stdout, stderr, exitCode, available }
 * available=false means the binary couldn't be found (spawn error).
 */
export type ExecResult = { stdout: string; stderr: string; exitCode: number; available: boolean };
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

let _execFn: ExecFn | null = null;

/** Override the exec implementation for tests. Pass null to restore default. */
export function _setExecFnForTesting(fn: ExecFn | null): void {
  _execFn = fn;
}

function defaultExec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { timeout: SUBPROCESS_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout, stderr, exitCode: 0, available: true });
        return;
      }
      // ENOENT / EACCES = binary not found → UNVERIFIABLE
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ stdout: '', stderr: String(err.message), exitCode: -1, available: false });
        return;
      }
      // Non-zero exit from an available binary
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? String(err.message),
        exitCode: (err as NodeJS.ErrnoException & { code?: number }).code ?? 1,
        available: true,
      });
    });
    void child; // spawned above; handled in callback
  });
}

function getExec(): ExecFn {
  return _execFn ?? defaultExec;
}

// ── Injectable fetch (for testing) ───────────────────────────

/**
 * Fetch function signature injectable for tests.
 * url: the full URL to GET
 * Returns { status, available } where available=false means connection failed.
 */
export type FetchResult = { status: number; available: boolean; error?: string };
export type FetchFn = (url: string) => Promise<FetchResult>;

let _fetchFn: FetchFn | null = null;

/** Override the fetch implementation for tests. Pass null to restore default. */
export function _setFetchFnForTesting(fn: FetchFn | null): void {
  _fetchFn = fn;
}

async function defaultFetch(url: string): Promise<FetchResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SUBPROCESS_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      return { status: resp.status, available: true };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    // ECONNREFUSED / AbortError / network error → daemon not reachable
    return { status: -1, available: false, error: String(err) };
  }
}

function getFetch(): FetchFn {
  return _fetchFn ?? defaultFetch;
}

// ── Claim extractors ─────────────────────────────────────────

/**
 * Extract PR references from text.
 *
 * Supported formats:
 *   #123
 *   PR #123
 *   PR 123
 *   pull request #123
 *   github.com/org/repo/pull/123
 *
 * Optionally captures an asserted title immediately after the ref in double
 * quotes: PR #123 "some title"
 *
 * Optionally captures review-state words (merged/approved/lgtm) that appear
 * within 60 chars before the ref.
 */
export function extractPrClaims(text: string): PrClaim[] {
  const seen = new Set<number>();
  const claims: PrClaim[] = [];

  // All PR number patterns (each capturing group 1 = pr number)
  const patterns: RegExp[] = [
    // "#123" — require word boundary before, not preceded by another digit
    /(?<![0-9])#(\d{1,6})\b/g,
    // "PR #123" or "PR 123"
    /\bPR\s+#?(\d{1,6})\b/gi,
    // "pull request #123" or "pull request 123"
    /\bpull\s+request\s+#?(\d{1,6})\b/gi,
    // GitHub URL
    /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d{1,6})/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    // Reset lastIndex between uses of a sticky/global regex
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const prNumber = parseInt(m[1]!, 10);
      if (isNaN(prNumber) || prNumber === 0) continue;
      if (seen.has(prNumber)) continue;
      seen.add(prNumber);

      const matchEnd = m.index + m[0].length;

      // Look for an asserted title in double quotes immediately after the ref
      // (within 20 chars, allowing for optional space/colon)
      let assertedTitle: string | undefined;
      const afterRef = text.slice(matchEnd, matchEnd + 120);
      const titleMatch = afterRef.match(/^\s*(?:[-:–]\s*)?["']([^"'\n]{1,120})["']/);
      if (titleMatch) {
        assertedTitle = titleMatch[1]!.trim();
      }

      // Look for review-state words in the 80 chars before the ref
      let assertedReviewState: string | undefined;
      const beforeRef = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
      if (/\bmerged?\b/.test(beforeRef)) assertedReviewState = 'merged';
      else if (/\bapproved?\b/.test(beforeRef)) assertedReviewState = 'approved';
      else if (/\blgtm\b/.test(beforeRef)) assertedReviewState = 'lgtm';

      claims.push({ type: 'pr', raw: m[0], prNumber, assertedTitle, assertedReviewState });
    }
  }

  return claims;
}

/**
 * Extract commit SHA references from text.
 *
 * Matches 7–40 hex chars surrounded by word boundaries. Requires the SHA
 * to appear in a recognizable git context (preceded by "commit", "sha",
 * "hash", "^", or followed by ".." or a word boundary-delimited position)
 * OR to be exactly 40 chars (full SHA — distinct from accidental hex).
 *
 * 7-char SHAs without context are included but may produce UNVERIFIABLE
 * rather than CONTRADICTED if git confirms they are valid objects of a
 * different type (blob/tree). This errs toward fewer false alarms.
 */
export function extractCommitClaims(text: string): CommitClaim[] {
  const seen = new Set<string>();
  const claims: CommitClaim[] = [];

  // Full SHA (40 hex) — always a candidate
  const fullSha = /\b([0-9a-f]{40})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = fullSha.exec(text)) !== null) {
    const sha = m[1]!.toLowerCase();
    if (!seen.has(sha)) {
      seen.add(sha);
      claims.push({ type: 'commit', raw: m[0], sha });
    }
  }

  // Short SHA (7–39 hex) — require explicit git context word before it
  const shortSha = /\b(?:commit|sha|hash)\s+([0-9a-f]{7,39})\b/gi;
  while ((m = shortSha.exec(text)) !== null) {
    const sha = m[1]!.toLowerCase();
    if (!seen.has(sha)) {
      seen.add(sha);
      claims.push({ type: 'commit', raw: m[0], sha });
    }
  }

  return claims;
}

/**
 * Extract file:line citations from text.
 *
 * Matches paths ending in a known source extension followed by :N where N > 0.
 * Does not match bare numbers (e.g., "port:80" won't match because port has
 * no file extension).
 */
export function extractFileLineClaims(text: string): FileLineClaim[] {
  const seen = new Set<string>();
  const claims: FileLineClaim[] = [];

  // path/to/file.ext:NNN — require a recognizable file extension
  const re = /\b([\w./-]+\.(?:ts|js|mjs|cjs|tsx|jsx|py|go|rs|rb|java|c|cpp|h|cs|sh|md|yaml|yml|json|toml|sql)):(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filePath = m[1]!;
    const lineNumber = parseInt(m[2]!, 10);
    const key = `${filePath}:${lineNumber}`;
    if (!seen.has(key) && lineNumber > 0) {
      seen.add(key);
      claims.push({ type: 'file_line', raw: m[0], filePath, lineNumber });
    }
  }

  return claims;
}

/**
 * Extract ISO date strings (YYYY-MM-DD) from text.
 *
 * Only includes dates that are syntactically plausible (month 01-12,
 * day 01-31). Full calendar validation happens in the validator.
 */
export function extractDateClaims(text: string): DateClaim[] {
  const seen = new Set<string>();
  const claims: DateClaim[] = [];

  const re = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const dateStr = m[0];
    if (!seen.has(dateStr)) {
      seen.add(dateStr);
      claims.push({ type: 'date', raw: m[0], dateStr });
    }
  }

  return claims;
}

/**
 * Extract orchestrator task ID references from text.
 *
 * Supported formats:
 *   - Dashed UUID (external_id): xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *   - 32-hex no-dashes (canonical_task_external_id): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * Requires the word 'task' or 'task_id' to appear within 80 chars before the ID
 * to avoid false positives (other hex-like strings, UUIDs from unrelated systems, etc.).
 * This conservative approach mirrors the short-SHA context-cue requirement.
 */
export function extractTaskClaims(text: string): TaskClaim[] {
  const seen = new Set<string>();
  const claims: TaskClaim[] = [];

  // Dashed UUID (external_id format): xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const dashedUuid = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = dashedUuid.exec(text)) !== null) {
    const taskId = m[1]!.toLowerCase();
    if (seen.has(taskId)) continue;
    const beforeId = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
    if (!/\btask(?:_id)?\b/.test(beforeId)) continue;
    seen.add(taskId);
    claims.push({ type: 'task', raw: m[0], taskId });
  }

  // 32-hex no-dashes (canonical_task_external_id format)
  // \b ensures we don't match a 32-char prefix of a longer hex string (e.g. 40-char commit SHA)
  const hexNoDash = /\b([0-9a-f]{32})\b/g;
  while ((m = hexNoDash.exec(text)) !== null) {
    const taskId = m[1]!.toLowerCase();
    if (seen.has(taskId)) continue;
    const beforeId = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
    if (!/\btask(?:_id)?\b/.test(beforeId)) continue;
    seen.add(taskId);
    claims.push({ type: 'task', raw: m[0], taskId });
  }

  return claims;
}

/**
 * Extract all claim types from result text.
 */
export function extractClaims(text: string): Claim[] {
  return [
    ...extractPrClaims(text),
    ...extractCommitClaims(text),
    ...extractFileLineClaims(text),
    ...extractDateClaims(text),
    ...extractTaskClaims(text),
  ];
}

// ── Validators ───────────────────────────────────────────────

/**
 * Validate a PR claim via `gh pr view`.
 *
 * VERIFIED    — PR exists (and title matches if asserted)
 * CONTRADICTED — PR doesn't exist, OR PR exists but asserted title differs
 * UNVERIFIABLE — gh not available or returns unexpected output
 */
export async function validatePrClaim(claim: PrClaim, execFn = getExec()): Promise<ClaimResult> {
  let res: ExecResult;
  try {
    res = await execFn('gh', ['pr', 'view', String(claim.prNumber), '--json', 'title,state,number']);
  } catch (err) {
    return { claim, verdict: 'UNVERIFIABLE', reason: `gh spawn error: ${String(err)}` };
  }

  if (!res.available) {
    return { claim, verdict: 'UNVERIFIABLE', reason: 'gh CLI not available' };
  }

  // Non-zero exit from gh means PR not found or auth error
  if (res.exitCode !== 0) {
    // gh returns exit 1 with a message like "no pull requests found" for missing PRs
    const isNotFound = res.stderr.toLowerCase().includes('not found')
      || res.stderr.toLowerCase().includes('no pull request')
      || res.stderr.toLowerCase().includes('could not resolve')
      || res.exitCode === 1;
    if (isNotFound) {
      return {
        claim,
        verdict: 'CONTRADICTED',
        reason: `PR #${claim.prNumber} not found: ${res.stderr.trim().slice(0, 200)}`,
      };
    }
    return {
      claim,
      verdict: 'UNVERIFIABLE',
      reason: `gh exited ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`,
    };
  }

  // Parse JSON response
  let prData: { title?: string; state?: string; number?: number };
  try {
    prData = JSON.parse(res.stdout) as { title?: string; state?: string; number?: number };
  } catch {
    return { claim, verdict: 'UNVERIFIABLE', reason: `gh returned non-JSON: ${res.stdout.slice(0, 200)}` };
  }

  const realTitle = prData.title ?? '';
  const realState = (prData.state ?? '').toLowerCase();

  // Check asserted title if present
  if (claim.assertedTitle) {
    const normalise = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
    if (normalise(realTitle) !== normalise(claim.assertedTitle)) {
      return {
        claim,
        verdict: 'CONTRADICTED',
        reason: `PR #${claim.prNumber} title mismatch: asserted "${claim.assertedTitle}" but real title is "${realTitle}"`,
      };
    }
  }

  // Check asserted review state
  if (claim.assertedReviewState) {
    const stateMap: Record<string, string[]> = {
      merged: ['merged'],
      approved: ['approved', 'merged'],
      lgtm: ['approved', 'merged'],
    };
    const acceptable = stateMap[claim.assertedReviewState] ?? [];
    if (!acceptable.includes(realState)) {
      return {
        claim,
        verdict: 'CONTRADICTED',
        reason: `PR #${claim.prNumber} state mismatch: asserted "${claim.assertedReviewState}" but actual state is "${realState}"`,
      };
    }
  }

  return {
    claim,
    verdict: 'VERIFIED',
    reason: `PR #${claim.prNumber} exists with title "${realTitle}" state="${realState}"`,
  };
}

/**
 * Validate a commit SHA via `git cat-file -t`.
 *
 * VERIFIED    — git reports the object type is 'commit'
 * CONTRADICTED — git is available but SHA is not a known object
 * UNVERIFIABLE — git not available or unknown error
 */
export async function validateCommitClaim(claim: CommitClaim, execFn = getExec()): Promise<ClaimResult> {
  let res: ExecResult;
  try {
    res = await execFn('git', ['cat-file', '-t', claim.sha]);
  } catch (err) {
    return { claim, verdict: 'UNVERIFIABLE', reason: `git spawn error: ${String(err)}` };
  }

  if (!res.available) {
    return { claim, verdict: 'UNVERIFIABLE', reason: 'git not available' };
  }

  if (res.exitCode !== 0) {
    return {
      claim,
      verdict: 'CONTRADICTED',
      reason: `SHA ${claim.sha} not found in repo: ${res.stderr.trim().slice(0, 200)}`,
    };
  }

  const objType = res.stdout.trim();
  if (objType === 'commit') {
    return { claim, verdict: 'VERIFIED', reason: `SHA ${claim.sha} is a commit object` };
  }

  // Object exists but is blob/tree/tag — not a commit
  return {
    claim,
    verdict: 'CONTRADICTED',
    reason: `SHA ${claim.sha} exists but is a ${objType}, not a commit`,
  };
}

/**
 * Validate a file:line citation.
 *
 * VERIFIED    — file exists and has at least N lines
 * CONTRADICTED — file exists but has fewer lines than cited, OR file absent
 * UNVERIFIABLE — stat error (permissions, odd path)
 */
export async function validateFileLineClaim(claim: FileLineClaim): Promise<ClaimResult> {
  try {
    if (!fs.existsSync(claim.filePath)) {
      return {
        claim,
        verdict: 'CONTRADICTED',
        reason: `File not found: ${claim.filePath}`,
      };
    }

    const content = fs.readFileSync(claim.filePath, 'utf8');
    const lineCount = content.split('\n').length;

    if (claim.lineNumber > lineCount) {
      return {
        claim,
        verdict: 'CONTRADICTED',
        reason: `${claim.filePath} has ${lineCount} lines but citation is line ${claim.lineNumber}`,
      };
    }

    return {
      claim,
      verdict: 'VERIFIED',
      reason: `${claim.filePath} exists with ${lineCount} lines (>= ${claim.lineNumber})`,
    };
  } catch (err) {
    return {
      claim,
      verdict: 'UNVERIFIABLE',
      reason: `Could not stat ${claim.filePath}: ${String(err)}`,
    };
  }
}

/**
 * Validate an ISO date claim.
 *
 * VERIFIED    — valid calendar date, not absurdly in the future (> 2 years)
 * CONTRADICTED — invalid calendar date (e.g., 2024-02-30) or > 5 years future
 * UNVERIFIABLE — parse error (shouldn't happen if extractor did its job)
 */
export async function validateDateClaim(claim: DateClaim): Promise<ClaimResult> {
  try {
    const [yearStr, monthStr, dayStr] = claim.dateStr.split('-');
    const year = parseInt(yearStr!, 10);
    const month = parseInt(monthStr!, 10);
    const day = parseInt(dayStr!, 10);

    // Construct and verify round-trip (catches Feb 30, Apr 31, etc.)
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month || d.getDate() !== day) {
      return {
        claim,
        verdict: 'CONTRADICTED',
        reason: `${claim.dateStr} is not a valid calendar date`,
      };
    }

    // Absurdly future check: > 5 years from now
    const fiveYearsOut = new Date();
    fiveYearsOut.setFullYear(fiveYearsOut.getFullYear() + 5);
    if (d > fiveYearsOut) {
      return {
        claim,
        verdict: 'CONTRADICTED',
        reason: `${claim.dateStr} is more than 5 years in the future`,
      };
    }

    return { claim, verdict: 'VERIFIED', reason: `${claim.dateStr} is a valid calendar date` };
  } catch (err) {
    return { claim, verdict: 'UNVERIFIABLE', reason: `Date parse error: ${String(err)}` };
  }
}

/**
 * Validate a task ID claim via the local daemon API.
 *
 * GET http://127.0.0.1:3847/api/orchestrator/tasks/:id
 *
 * VERIFIED      — daemon returns HTTP 200 (task exists)
 * CONTRADICTED  — daemon returns HTTP 404 (task not found — likely fabricated)
 * UNVERIFIABLE  — connection refused, timeout, or unexpected non-200/404 status
 *
 * Fail-safe: any error or unexpected status degrades to UNVERIFIABLE, never
 * to CONTRADICTED. Only an explicit 404 from a reachable daemon triggers
 * CONTRADICTED, matching the same conservative pattern as the gh/git validators.
 */
export async function validateTaskClaim(
  claim: TaskClaim,
  fetchFn = getFetch(),
): Promise<ClaimResult> {
  const url = `http://127.0.0.1:3847/api/orchestrator/tasks/${claim.taskId}`;
  let result: FetchResult;
  try {
    result = await fetchFn(url);
  } catch (err) {
    return { claim, verdict: 'UNVERIFIABLE', reason: `fetch error: ${String(err)}` };
  }

  if (!result.available) {
    return {
      claim,
      verdict: 'UNVERIFIABLE',
      reason: `Daemon not reachable: ${result.error ?? 'connection failed'}`,
    };
  }

  if (result.status === 200) {
    return {
      claim,
      verdict: 'VERIFIED',
      reason: `Task ${claim.taskId} confirmed in daemon (HTTP 200)`,
    };
  }

  if (result.status === 404) {
    return {
      claim,
      verdict: 'CONTRADICTED',
      reason: `Task ${claim.taskId} not found in daemon (HTTP 404) — fabricated ID`,
    };
  }

  // Any other status (401, 500, etc.) → UNVERIFIABLE (fail-safe, not CONTRADICTED)
  return {
    claim,
    verdict: 'UNVERIFIABLE',
    reason: `Unexpected daemon response HTTP ${result.status} for task ${claim.taskId}`,
  };
}

// ── Core verification logic ───────────────────────────────────

/**
 * Run verification for a single job. Returns the full report.
 * Never throws — all errors are captured into UNVERIFIABLE results.
 */
export async function runVerification(
  job: JobRecord,
  execFn?: ExecFn,
): Promise<VerificationReport> {
  const timestamp = new Date().toISOString();
  const eFn = execFn ?? getExec();

  // Empty/whitespace result on completed job → immediate quarantine, no claim extraction
  if (job.status === 'completed' && (!job.result || job.result.trim() === '')) {
    return {
      jobId: job.id,
      timestamp,
      claims: [],
      quarantined: true,
      quarantineReason: 'Job status=completed but result is empty/whitespace',
    };
  }

  const text = job.result ?? '';
  const claims = extractClaims(text);

  // No claims → clean (nothing to contradict)
  if (claims.length === 0) {
    return { jobId: job.id, timestamp, claims: [], quarantined: false };
  }

  // Validate all claims in parallel (each bounded by SUBPROCESS_TIMEOUT_MS internally)
  const results: ClaimResult[] = await Promise.all(
    claims.map(async claim => {
      try {
        switch (claim.type) {
          case 'pr':        return validatePrClaim(claim, eFn);
          case 'commit':    return validateCommitClaim(claim, eFn);
          case 'file_line': return validateFileLineClaim(claim);
          case 'date':      return validateDateClaim(claim);
          case 'task':      return validateTaskClaim(claim);
        }
      } catch (err) {
        return {
          claim,
          verdict: 'UNVERIFIABLE' as Verdict,
          reason: `Validator threw: ${String(err)}`,
        };
      }
    }),
  );

  const contradicted = results.filter(r => r.verdict === 'CONTRADICTED');
  const quarantined = contradicted.length > 0;

  return {
    jobId: job.id,
    timestamp,
    claims: results,
    quarantined,
    quarantineReason: quarantined
      ? `${contradicted.length} contradicted claim(s): ${contradicted.map(r => r.reason).join('; ').slice(0, 400)}`
      : undefined,
  };
}

// ── Persistence and notification ──────────────────────────────

function persistReport(jobId: string, report: VerificationReport): void {
  const status = !report.quarantined && report.claims.length === 0
    ? 'skipped'
    : report.quarantined
      ? 'quarantined'
      : 'clean';

  const fields: Record<string, unknown> = {
    verification_status: status,
    verification_report: JSON.stringify(report),
  };
  if (report.quarantined) {
    fields['verification_flagged_at'] = report.timestamp;
  }

  update('worker_jobs', jobId, fields);
}

function notifyComms(jobId: string, report: VerificationReport): void {
  if (!report.quarantined) return;

  const contradicted = report.claims.filter(r => r.verdict === 'CONTRADICTED');
  const unverifiable = report.claims.filter(r => r.verdict === 'UNVERIFIABLE');

  const lines: string[] = [
    `[fact-verifier] Job ${jobId} QUARANTINED — held for review.`,
    `Quarantine reason: ${report.quarantineReason ?? 'unknown'}`,
  ];
  if (contradicted.length > 0) {
    lines.push(`Contradicted claims (${contradicted.length}):`);
    for (const r of contradicted.slice(0, 5)) {
      lines.push(`  • ${r.reason}`);
    }
  }
  if (unverifiable.length > 0) {
    lines.push(`Unverifiable claims (${unverifiable.length}) — could not check: ${unverifiable.map(r => r.claim.raw).join(', ').slice(0, 200)}`);
  }
  lines.push(`Worker output preserved. Review with: GET /api/agents/${jobId}/status`);

  try {
    sendMessage({
      from: 'daemon',
      to: 'comms',
      type: 'status',
      body: lines.join('\n'),
      metadata: { fact_verifier: true, job_id: jobId, quarantined: true },
    });
  } catch (err) {
    // Notification failure must never crash the daemon
    log.warn(`fact-verifier: failed to notify comms for job ${jobId}`, { err: String(err) });
  }
}

// ── Entry point ───────────────────────────────────────────────

/**
 * Verify a completed job. Runs async, fire-and-forget.
 * Bounded by JOB_TIMEOUT_MS. Never throws.
 */
async function verifyJob(job: JobRecord): Promise<void> {
  // Skip retro workers and other verifier-spawned jobs to avoid infinite loops
  if (job.profile === 'retro' || job.profile === 'fact-verifier') return;

  try {
    const report = await Promise.race([
      runVerification(job),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('verification timeout')), JOB_TIMEOUT_MS),
      ),
    ]);

    persistReport(job.id, report);
    notifyComms(job.id, report);

    if (report.quarantined) {
      log.warn(`fact-verifier: job ${job.id} quarantined`, {
        jobId: job.id,
        reason: report.quarantineReason,
        contradicted: report.claims.filter(r => r.verdict === 'CONTRADICTED').length,
      });
    } else {
      log.info(`fact-verifier: job ${job.id} verified clean`, {
        jobId: job.id,
        claimCount: report.claims.length,
      });
    }
  } catch (err) {
    log.warn(`fact-verifier: verification failed for job ${job.id}`, { err: String(err) });
    // Persist error status so the job isn't left with verification_status=null
    try {
      update('worker_jobs', job.id, { verification_status: 'error' });
    } catch {
      // DB write failures are non-fatal
    }
  }
}

/**
 * Register the fact verifier as a job-complete listener.
 * Call once at daemon startup.
 */
export function registerFactVerifier(): void {
  addOnJobComplete((job: JobRecord) => {
    // Only verify terminal jobs (completed/failed/timeout)
    // The verifier is primarily useful for completed jobs; failed/timeout
    // jobs may have partial output but we still extract what we can.
    void verifyJob(job);
  });
  log.info('fact-verifier: registered');
}
