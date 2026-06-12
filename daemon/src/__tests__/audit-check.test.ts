/**
 * Mutation-killer tests for scripts/audit-check.mjs
 *
 * Verifies two critical invariants:
 *   (a) An allowlisted (non-expired) advisory is SUPPRESSED → wrapper exits 0 (PASS)
 *   (b) A non-allowlisted advisory → wrapper exits non-zero (FAIL)
 *
 * Test (b) is the mutation-killer: if the fail-on-non-allowlisted logic is
 * removed or neutered, this test goes RED.
 *
 * Audit data is injected via KKIT_AUDIT_JSON_FILE so no live npm network call
 * is made. Allowlist is injected via KKIT_AUDIT_ALLOWLIST.
 *
 * CI glob that covers this file:
 *   find dist -name '*.test.js' -not -path '*\/node_modules\/*' -not -name 'plan-approval.test.js'
 * (daemon/package.json "test" script — exact string in ci.yml)
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the script under test — from daemon/dist/__tests__/ up 3 to repo root, then scripts/
const SCRIPT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'audit-check.mjs',
);

// ── Fixture helpers ────────────────────────────────────────────────────────

/** Write a JSON fixture to a temp file and return its path. */
function writeFixture(dir: string, name: string, obj: unknown): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  return filePath;
}

/** Run audit-check.mjs with the given audit JSON and allowlist files. */
function runAuditCheck(auditJsonFile: string, allowlistFile: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      KKIT_AUDIT_JSON_FILE: auditJsonFile,
      KKIT_AUDIT_ALLOWLIST: allowlistFile,
    },
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** npm audit v2 JSON with one GHSA advisory. */
function auditJsonWith(ghsaId: string): unknown {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      'some-package': {
        name: 'some-package',
        severity: 'moderate',
        isDirect: true,
        via: [
          {
            source: 123456,
            name: 'some-package',
            dependency: 'some-package',
            title: `Test advisory for ${ghsaId}`,
            url: `https://github.com/advisories/${ghsaId}`,
            severity: 'moderate',
            range: '<2.0.0',
          },
        ],
        effects: [],
        range: '<2.0.0',
        nodes: ['node_modules/some-package'],
        fixAvailable: true,
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
      dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
    },
  };
}

/** npm audit v2 JSON with no vulnerabilities. */
const auditJsonClean: unknown = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
  },
};

/** Allowlist with a single non-expired entry for GHSA-TEST-ABCD-1234. */
const allowlistWithEntry = (ghsaId: string, expires = '2099-12-31') => ({
  allowlist: [
    {
      id: ghsaId,
      expires,
      reason: 'Test fixture — dependency path not reachable in this environment.',
    },
  ],
});

/** Empty allowlist (no entries). */
const allowlistEmpty = { allowlist: [] };

// ── Test suite ─────────────────────────────────────────────────────────────

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-audit-check-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('audit-check.mjs allowlist mechanism', () => {
  const TEST_GHSA = 'GHSA-TEST-ABCD-1234';

  it('(a) PASS — allowlisted non-expired advisory is suppressed (exit 0)', () => {
    const auditFile = writeFixture(tmpDir, 'audit-allowlisted.json', auditJsonWith(TEST_GHSA));
    const allowlistFile = writeFixture(
      tmpDir,
      'allowlist-has-entry.json',
      allowlistWithEntry(TEST_GHSA),
    );

    const result = runAuditCheck(auditFile, allowlistFile);

    assert.equal(
      result.status,
      0,
      `Expected exit 0 for allowlisted advisory, got ${result.status}.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /SUPPRESSED/,
      'Expected "SUPPRESSED" in stdout when advisory is in allowlist',
    );
    assert.match(
      result.stdout,
      new RegExp(TEST_GHSA, 'i'),
      'Expected the advisory id to appear in suppression log',
    );
  });

  it('(b) FAIL — non-allowlisted advisory causes non-zero exit (mutation-killer)', () => {
    const OTHER_GHSA = 'GHSA-NOT-IN-LIST-0000';
    const auditFile = writeFixture(tmpDir, 'audit-unlisted.json', auditJsonWith(OTHER_GHSA));
    // Allowlist contains a DIFFERENT id — the OTHER_GHSA is NOT in it.
    const allowlistFile = writeFixture(
      tmpDir,
      'allowlist-different.json',
      allowlistWithEntry(TEST_GHSA), // TEST_GHSA listed, but advisory is OTHER_GHSA
    );

    const result = runAuditCheck(auditFile, allowlistFile);

    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit for non-allowlisted advisory, got ${result.status}.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /FAIL/,
      'Expected "FAIL" in stderr for non-allowlisted advisory',
    );
    assert.match(
      result.stderr,
      new RegExp(OTHER_GHSA, 'i'),
      'Expected the unlisted advisory id in stderr failure message',
    );
  });

  it('PASS — no advisories at all exits 0', () => {
    const auditFile = writeFixture(tmpDir, 'audit-clean.json', auditJsonClean);
    const allowlistFile = writeFixture(tmpDir, 'allowlist-empty.json', allowlistEmpty);

    const result = runAuditCheck(auditFile, allowlistFile);

    assert.equal(
      result.status,
      0,
      `Expected exit 0 for clean audit, got ${result.status}.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });

  it('FAIL — expired allowlist entry causes non-zero exit', () => {
    const EXPIRED_GHSA = 'GHSA-EXPI-RED0-0001';
    const auditFile = writeFixture(tmpDir, 'audit-expired.json', auditJsonWith(EXPIRED_GHSA));
    const allowlistFile = writeFixture(
      tmpDir,
      'allowlist-expired.json',
      allowlistWithEntry(EXPIRED_GHSA, '2020-01-01'), // expired in the past
    );

    const result = runAuditCheck(auditFile, allowlistFile);

    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit for expired allowlist entry, got ${result.status}.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /EXPIRED/,
      'Expected "EXPIRED" in stderr when allowlist entry is past its expiry date',
    );
  });

  it('FAIL — allowlist entry missing required fields causes exit 1', () => {
    const auditFile = writeFixture(tmpDir, 'audit-any.json', auditJsonClean);
    // Entry missing 'reason'
    const badAllowlist = { allowlist: [{ id: 'GHSA-XXXX-XXXX-0001', expires: '2099-12-31' }] };
    const allowlistFile = writeFixture(tmpDir, 'allowlist-bad.json', badAllowlist);

    const result = runAuditCheck(auditFile, allowlistFile);

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for malformed allowlist entry, got ${result.status}.\n` +
        `stderr: ${result.stderr}`,
    );
  });
});
