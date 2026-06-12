/**
 * Mutation-killer test: leak-check EXCLUDE list covers test/ and __tests__/ paths.
 *
 * Regression guard for todo #715: instance-id-looking tokens inside test
 * fixtures were falsely tripped by the leak-check because test/ and __tests__/
 * were not in the exclusion list.
 *
 * CI coverage: daemon "npm test" glob in ci.yml:
 *   find dist -name '*.test.js' (excluding node_modules and plan-approval)
 * which picks up daemon/dist/__tests__/leak-check-path-exclusion.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolve project root from compiled location: daemon/dist/__tests__/ → ../../.. → root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract EXCLUDE value from .github/workflows/ci.yml (single-quoted shell assignment). */
function extractCiExclude(): string {
  const ciYml = readFileSync(
    path.join(PROJECT_ROOT, '.github/workflows/ci.yml'),
    'utf8',
  );
  const m = ciYml.match(/\bEXCLUDE='([^']+)'/);
  if (!m) throw new Error('Could not parse EXCLUDE from ci.yml');
  return m[1];
}

/** Extract EXCLUSIONS value from scripts/install-hooks.sh (double-quoted shell assignment). */
function extractHookExclusions(): string {
  const hookSh = readFileSync(
    path.join(PROJECT_ROOT, 'scripts/install-hooks.sh'),
    'utf8',
  );
  const m = hookSh.match(/\bEXCLUSIONS="([^"]+)"/);
  if (!m) throw new Error('Could not parse EXCLUSIONS from install-hooks.sh');
  return m[1];
}

/**
 * Simulate the bash leak-check pipeline in JavaScript:
 *   1. Keep only files with relevant extensions
 *   2. Exclude files whose path matches the exclude pattern (grep -v -E)
 *   3. Flag files whose content matches the blocked pattern (grep -nE)
 *
 * Returns the paths of files that would be flagged as leaks.
 */
function runLeakCheck(
  files: Array<{ path: string; content: string }>,
  excludePattern: string,
  blockedPattern: string,
): string[] {
  const relevantExt = /\.(ts|js|yaml|yml|json|md|sh)$/;
  const exclude = new RegExp(excludePattern);
  const blocked = new RegExp(blockedPattern);

  return files
    .filter(f => relevantExt.test(f.path))   // extension filter (matches bash glob)
    .filter(f => !exclude.test(f.path))       // path exclusion (grep -v -E "$EXCLUDE")
    .filter(f => blocked.test(f.content))     // pattern match  (grep -nE "$PATTERN")
    .map(f => f.path);
}

// ── A canary token that appears in BLOCKED_PATTERNS ──────────────────────────
// Using a token that is in both ci.yml PATTERNS and install-hooks.sh BLOCKED_PATTERNS.
// This simulates a real instance-specific string that legitimately appears in test fixtures.
const CANARY_TOKEN = 'R2D2';

// ── ci.yml EXCLUDE tests ─────────────────────────────────────────────────────

describe('Leak-check EXCLUDE (ci.yml): test/ and __tests__/ path exclusions', () => {
  it('(a) token inside test/ is NOT flagged — ci.yml EXCLUDE', () => {
    const exclude = extractCiExclude();
    const flagged = runLeakCheck(
      [{ path: 'test/fixtures/instance-id-fixture.ts', content: `const instanceId = '${CANARY_TOKEN}';` }],
      exclude,
      CANARY_TOKEN,
    );
    assert.deepEqual(
      flagged,
      [],
      `test/ path should be excluded; got flagged: ${JSON.stringify(flagged)}`,
    );
  });

  it('(a) token inside __tests__/ is NOT flagged — ci.yml EXCLUDE', () => {
    const exclude = extractCiExclude();
    const flagged = runLeakCheck(
      [{ path: 'daemon/src/__tests__/instance-id-fixture.test.ts', content: `// canary: ${CANARY_TOKEN}` }],
      exclude,
      CANARY_TOKEN,
    );
    assert.deepEqual(
      flagged,
      [],
      `__tests__/ path should be excluded; got flagged: ${JSON.stringify(flagged)}`,
    );
  });

  it('(b) same token outside test paths IS flagged — ci.yml EXCLUDE', () => {
    const exclude = extractCiExclude();
    const flagged = runLeakCheck(
      [{ path: 'daemon/src/service.ts', content: `// leaked: ${CANARY_TOKEN}` }],
      exclude,
      CANARY_TOKEN,
    );
    assert.deepEqual(
      flagged,
      ['daemon/src/service.ts'],
      `Non-test file with blocked token must be flagged; got: ${JSON.stringify(flagged)}`,
    );
  });

  it('(a+b) mixed batch: test/ excluded, src/ flagged — ci.yml EXCLUDE', () => {
    const exclude = extractCiExclude();
    const flagged = runLeakCheck(
      [
        { path: 'test/fixtures/token-fixture.ts', content: `// fixture: ${CANARY_TOKEN}` },
        { path: 'daemon/src/__tests__/helper.test.ts', content: `// helper: ${CANARY_TOKEN}` },
        { path: 'daemon/src/core/real-leak.ts', content: `const id = '${CANARY_TOKEN}';` },
      ],
      exclude,
      CANARY_TOKEN,
    );
    assert.deepEqual(
      flagged,
      ['daemon/src/core/real-leak.ts'],
      `Only the non-test file should be flagged; got: ${JSON.stringify(flagged)}`,
    );
  });
});

// ── install-hooks.sh EXCLUSIONS tests ────────────────────────────────────────

describe('Leak-check EXCLUSIONS (install-hooks.sh): test/ and __tests__/ path exclusions', () => {
  it('(a) token inside test/ is NOT flagged — install-hooks.sh EXCLUSIONS', () => {
    const exclude = extractHookExclusions();
    const flagged = runLeakCheck(
      [{ path: 'test/fixtures/instance-id-fixture.ts', content: `const instanceId = '${CANARY_TOKEN}';` }],
      exclude,
      CANARY_TOKEN,
    );
    assert.deepEqual(
      flagged,
      [],
      `test/ path should be excluded in hook; got flagged: ${JSON.stringify(flagged)}`,
    );
  });

  it('(a) token inside __tests__/ is NOT flagged — install-hooks.sh EXCLUSIONS', () => {
    const exclude = extractHookExclusions();
    const flagged = runLeakCheck(
      [{ path: 'daemon/src/__tests__/instance-id-fixture.test.ts', content: `// canary: ${CANARY_TOKEN}` }],
      exclude,
      CANARY_TOKEN,
    );
    assert.deepEqual(
      flagged,
      [],
      `__tests__/ path should be excluded in hook; got flagged: ${JSON.stringify(flagged)}`,
    );
  });

  it('(b) same token outside test paths IS flagged — install-hooks.sh EXCLUSIONS', () => {
    const exclude = extractHookExclusions();
    const flagged = runLeakCheck(
      [{ path: 'daemon/src/service.ts', content: `// leaked: ${CANARY_TOKEN}` }],
      exclude,
      CANARY_TOKEN,
    );
    assert.deepEqual(
      flagged,
      ['daemon/src/service.ts'],
      `Non-test file with blocked token must be flagged in hook; got: ${JSON.stringify(flagged)}`,
    );
  });

  it('(a+b) mixed batch: test/ excluded, src/ flagged — install-hooks.sh EXCLUSIONS', () => {
    const exclude = extractHookExclusions();
    const flagged = runLeakCheck(
      [
        { path: 'test/fixtures/token-fixture.ts', content: `// fixture: ${CANARY_TOKEN}` },
        { path: 'daemon/src/__tests__/helper.test.ts', content: `// helper: ${CANARY_TOKEN}` },
        { path: 'daemon/src/core/real-leak.ts', content: `const id = '${CANARY_TOKEN}';` },
      ],
      exclude,
      CANARY_TOKEN,
    );
    assert.deepEqual(
      flagged,
      ['daemon/src/core/real-leak.ts'],
      `Only the non-test file should be flagged in hook; got: ${JSON.stringify(flagged)}`,
    );
  });
});

// ── Consistency guard ─────────────────────────────────────────────────────────

describe('Leak-check exclusion consistency: ci.yml and install-hooks.sh stay in sync', () => {
  it('both EXCLUDE and EXCLUSIONS contain test/ pattern', () => {
    const ciExclude = extractCiExclude();
    const hookExclusions = extractHookExclusions();
    assert.ok(
      /\btest\//.test(ciExclude),
      `ci.yml EXCLUDE missing 'test/' — found: ${ciExclude}`,
    );
    assert.ok(
      /\btest\//.test(hookExclusions),
      `install-hooks.sh EXCLUSIONS missing 'test/' — found: ${hookExclusions}`,
    );
  });

  it('both EXCLUDE and EXCLUSIONS contain __tests__/ pattern', () => {
    const ciExclude = extractCiExclude();
    const hookExclusions = extractHookExclusions();
    assert.ok(
      /__tests__\//.test(ciExclude),
      `ci.yml EXCLUDE missing '__tests__/' — found: ${ciExclude}`,
    );
    assert.ok(
      /__tests__\//.test(hookExclusions),
      `install-hooks.sh EXCLUSIONS missing '__tests__/' — found: ${hookExclusions}`,
    );
  });
});
