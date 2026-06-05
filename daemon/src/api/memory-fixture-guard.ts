/**
 * memory-fixture-guard — defense-in-depth at the extraction layer.
 *
 * Guards the POST /api/memory/store endpoint against persisting test-fixture
 * and canary content as real memories.  This is the extraction-layer component
 * of the fix for kithkit#301 (memory auto-extraction creates fixture poisoning
 * feedback loop).
 *
 * Background
 * ----------
 * The memory auto-extraction pipeline (memory-extraction.sh, transcript-review.sh)
 * reads agent transcripts and stores "learnings" by calling POST /api/memory/store.
 * When a test run or fixture-replay session touches those transcripts, the extractor
 * sees canary strings — alice@example.com as a "safe sender", KITHKIT test env vars,
 * the literal canary injected into tmux tests — and persists them as canonical facts.
 * Later hybrid-search surfaces these fake entries alongside real knowledge, eroding
 * operator trust.  Worse: a cleanup conversation that references the canary strings
 * triggers re-extraction within minutes, creating a re-poisoning loop.
 *
 * Signature list
 * --------------
 * Patterns here must be definitively test-only — never appearing in legitimate
 * production content.  Each entry is annotated with its source fixture.
 *
 * Guard is intentionally narrow.  Prefer false-negatives (a fixture slipping through
 * once) over false-positives (a real learning being silently dropped).
 *
 * Related issues: kithkit#301 (this fix), kithkit#299 (channel-layer leak, #353
 * addressed the source), kithkit#689 purge record (local todo tracking fleet cleanup).
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('memory-fixture-guard');

// ── Signature set ────────────────────────────────────────────

/**
 * Each entry is either a literal string (case-sensitive substring match)
 * or a RegExp.  Rationale is documented inline.
 */
export const FIXTURE_PATTERNS: ReadonlyArray<string | RegExp> = [
  // RFC 2606 reserved example domains — alice@example.com, eve@example.com,
  // bob@example.com, etc.  These ONLY appear in approval-gate, email-inbox,
  // and access-control test fixtures (kithkit#299, kithkit#301).
  /@example\.(com|org|net)\b/i,

  // Literal canary string injected in daemon/src/__tests__/tmux.test.ts:124
  // to assert that the production guard blocks test-runner injections.
  'canary-regression-guard-test',

  // Test-injection env var.  Appears in test-harness discussions and fixture
  // transcripts but never in production agent operational content.
  'KITHKIT_ALLOW_TEST_INJECT',

  // Test-isolation env var.  Same class as above.
  'KITHKIT_SUPPRESS_NOTIFICATIONS',
];

// ── Predicate ────────────────────────────────────────────────

/**
 * Returns true when `content` contains at least one known canary or
 * test-fixture pattern.  Content matching any pattern MUST NOT be written
 * to the memory store.
 *
 * @param content  The candidate memory content string.
 */
export function isCanaryOrFixtureContent(content: string): boolean {
  for (const pattern of FIXTURE_PATTERNS) {
    if (typeof pattern === 'string') {
      if (content.includes(pattern)) return true;
    } else {
      if (pattern.test(content)) return true;
    }
  }
  return false;
}

/**
 * Emit a structured log entry when content is skipped due to the guard.
 * Logs at WARN level so operators can observe the guard doing work and
 * verify the fix is active without enabling debug-level logging.
 */
export function logSkippedFixtureContent(content: string, source?: string): void {
  log.warn('memory-fixture-guard: skipped canary/fixture content', {
    source: source ?? 'unknown',
    content_prefix: content.slice(0, 80),
  });
}
